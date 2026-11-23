// Command proxy is a small, read-only HTTP facade in front of the local Docker Engine.
//
// Why it exists: the Docker socket is a privileged Unix socket, and 3Dokploy only needs
// to read a handful of resources. This process speaks the Docker Engine API over
// /var/run/docker.sock and exposes a fixed, read-only JSON surface to 3Dokploy's Node
// server. It never forwards arbitrary paths and never accepts a method other than GET.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultAddr   = "127.0.0.1:3101"
	defaultSocket = "/var/run/docker.sock"
	maxLogTail    = 500
	maxLogBytes   = 4 << 20
	statsWorkers  = 8
	statsCacheTTL = 2 * time.Second
	statsTimeout  = 25 * time.Second
	dockerTimeout = 10 * time.Second
)

// Container IDs and names we are willing to look up. Anything else is refused before it
// can reach a URL path.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// ---- Docker client ------------------------------------------------------------------------

type docker struct {
	client *http.Client
}

func newDocker(socket string) *docker {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns:    32,
		IdleConnTimeout: 90 * time.Second,
	}
	return &docker{client: &http.Client{Transport: tr}}
}

// do performs one GET against the engine. The caller owns the response body.
func (d *docker) do(ctx context.Context, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	return d.client.Do(req)
}

// upstreamError is a non-2xx answer from the engine.
type upstreamError struct {
	status int
	msg    string
}

func (e *upstreamError) Error() string { return e.msg }

func (d *docker) getJSON(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, dockerTimeout)
	defer cancel()
	resp, err := d.do(ctx, path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return &upstreamError{status: resp.StatusCode, msg: dockerMessage(resp.Body)}
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func dockerMessage(r io.Reader) string {
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(r, 1<<16)).Decode(&body); err == nil && body.Message != "" {
		return body.Message
	}
	return "the Docker engine returned an error"
}

// ---- data ---------------------------------------------------------------------------------

type rawSummary struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
	Health *struct {
		Status string `json:"Status"`
	} `json:"Health"`
}

type container struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	Image  string            `json:"image"`
	State  string            `json:"state"`
	Status string            `json:"status,omitempty"`
	Health string            `json:"health,omitempty"`
	Labels map[string]string `json:"labels"`
}

func summarize(raw rawSummary) container {
	c := container{
		ID:     raw.ID,
		Image:  raw.Image,
		State:  raw.State,
		Status: raw.Status,
		Labels: raw.Labels,
	}
	if len(raw.Names) > 0 {
		c.Name = strings.TrimPrefix(raw.Names[0], "/")
	}
	if raw.Health != nil {
		c.Health = raw.Health.Status
	}
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	return c
}

type rawInspect struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
}

type rawStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

// stat is the reduced shape the browser consumes: cpu as a fraction of one core,
// memory in MiB, cumulative network counters in bytes.
type stat struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	CPU        float64 `json:"cpu"`
	MemMb      float64 `json:"memMb"`
	MemLimitMb float64 `json:"memLimitMb"`
	Rx         uint64  `json:"rx"`
	Tx         uint64  `json:"tx"`
}

type hostInfo struct {
	Name     string `json:"name"`
	CPUs     int    `json:"cpus"`
	MemTotal int64  `json:"memTotal"`
	Version  string `json:"version"`
}

// ---- server -------------------------------------------------------------------------------

type server struct {
	d *docker

	statsMu   sync.Mutex
	statsAt   time.Time
	statsBody []byte
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *server) version(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Version       string `json:"Version"`
		APIVersion    string `json:"ApiVersion"`
		MinAPIVersion string `json:"MinAPIVersion"`
		OS            string `json:"Os"`
		Arch          string `json:"Arch"`
	}
	if err := s.d.getJSON(r.Context(), "/version", &v); err != nil {
		writeDockerError(w, err)
		return
	}
	writeJSON(w, map[string]string{
		"version":    v.Version,
		"apiVersion": v.APIVersion,
		"os":         v.OS,
		"arch":       v.Arch,
	})
}

func (s *server) info(w http.ResponseWriter, r *http.Request) {
	var raw struct {
		Name          string `json:"Name"`
		NCPU          int    `json:"NCPU"`
		MemTotal      int64  `json:"MemTotal"`
		ServerVersion string `json:"ServerVersion"`
	}
	if err := s.d.getJSON(r.Context(), "/info", &raw); err != nil {
		writeDockerError(w, err)
		return
	}
	writeJSON(w, hostInfo{Name: raw.Name, CPUs: raw.NCPU, MemTotal: raw.MemTotal, Version: raw.ServerVersion})
}

func (s *server) listContainers(w http.ResponseWriter, r *http.Request) {
	var raw []rawSummary
	if err := s.d.getJSON(r.Context(), "/containers/json?all=1", &raw); err != nil {
		writeDockerError(w, err)
		return
	}
	out := make([]container, 0, len(raw))
	for _, c := range raw {
		out = append(out, summarize(c))
	}
	writeJSON(w, out)
}

func (s *server) container(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid container id")
		return
	}
	var raw rawInspect
	if err := s.d.getJSON(r.Context(), "/containers/"+id+"/json", &raw); err != nil {
		writeDockerError(w, err)
		return
	}
	c := container{
		ID:     raw.ID,
		Name:   strings.TrimPrefix(raw.Name, "/"),
		Image:  raw.Config.Image,
		State:  raw.State.Status,
		Labels: raw.Config.Labels,
	}
	if raw.State.Health != nil {
		c.Health = raw.State.Health.Status
	}
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	writeJSON(w, c)
}

func (s *server) logs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid container id")
		return
	}
	tail := 200
	if v := r.URL.Query().Get("tail"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			tail = min(n, maxLogTail)
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), dockerTimeout)
	defer cancel()
	resp, err := s.d.do(ctx, fmt.Sprintf("/containers/%s/logs?stdout=1&stderr=1&timestamps=0&tail=%d", id, tail))
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("can't reach the Docker engine: %v", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		writeDockerError(w, &upstreamError{status: resp.StatusCode, msg: dockerMessage(resp.Body)})
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxLogBytes))
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not read container logs")
		return
	}
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	_, _ = w.Write(demux(body))
}

// demux turns Docker's multiplexed log stream (8-byte frame headers per chunk) into plain
// text. Containers with a TTY, and non-framed output, are returned unchanged.
func demux(b []byte) []byte {
	if len(b) < 8 || b[0] > 2 || b[1] != 0 || b[2] != 0 || b[3] != 0 {
		return b
	}
	var out []byte
	for len(b) >= 8 {
		size := int(binary.BigEndian.Uint32(b[4:8]))
		if size < 0 || len(b) < 8+size {
			return append(out, b...)
		}
		out = append(out, b[8:8+size]...)
		b = b[8+size:]
	}
	return append(out, b...)
}

// handleStats reads one stats sample per running container. Docker needs two consecutive
// stream samples for a CPU delta (the first one carries precpu = 0), so each container costs
// about a second. The result is cached briefly so a polling browser does not trigger it on
// every request.
func (s *server) handleStats(w http.ResponseWriter, r *http.Request) {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	if time.Since(s.statsAt) < statsCacheTTL && s.statsBody != nil {
		writeJSONBytes(w, s.statsBody)
		return
	}

	stats, err := s.collectStats(r.Context())
	if err != nil {
		writeDockerError(w, err)
		return
	}
	body, err := json.Marshal(stats)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not encode stats")
		return
	}
	s.statsBody, s.statsAt = body, time.Now()
	writeJSONBytes(w, body)
}

func (s *server) collectStats(ctx context.Context) ([]stat, error) {
	var list []rawSummary
	if err := s.d.getJSON(ctx, "/containers/json", &list); err != nil {
		return nil, err
	}

	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		sem = make(chan struct{}, statsWorkers)
		out = make([]stat, 0, len(list))
	)
	for _, c := range list {
		c := c
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			st, err := s.oneStat(ctx, c)
			if err != nil {
				log.Printf("stats %s: %v", shortID(c.ID), err)
				return
			}
			mu.Lock()
			out = append(out, st)
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *server) oneStat(ctx context.Context, c rawSummary) (stat, error) {
	ctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	resp, err := s.d.do(ctx, "/containers/"+c.ID+"/stats?stream=true")
	if err != nil {
		return stat{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return stat{}, &upstreamError{status: resp.StatusCode, msg: dockerMessage(resp.Body)}
	}

	dec := json.NewDecoder(resp.Body)
	var first, sample rawStats
	if err := dec.Decode(&first); err != nil {
		return stat{}, err
	}
	// The second sample carries the first one as its precpu baseline.
	if err := dec.Decode(&sample); err != nil {
		return stat{}, err
	}

	st := stat{ID: c.ID, Name: summarize(c).Name}
	if sample.CPUStats.SystemUsage > sample.PreCPUStats.SystemUsage &&
		sample.CPUStats.CPUUsage.TotalUsage >= sample.PreCPUStats.CPUUsage.TotalUsage {
		cpuDelta := float64(sample.CPUStats.CPUUsage.TotalUsage - sample.PreCPUStats.CPUUsage.TotalUsage)
		sysDelta := float64(sample.CPUStats.SystemUsage - sample.PreCPUStats.SystemUsage)
		online := float64(sample.CPUStats.OnlineCPUs)
		if online == 0 {
			online = 1
		}
		// Fraction of one core, matching `docker stats` CPUPerc divided by 100.
		st.CPU = cpuDelta / sysDelta * online
	}

	mem := sample.MemoryStats.Usage
	if inactive, ok := sample.MemoryStats.Stats["inactive_file"]; ok && inactive > 0 && mem > inactive {
		mem -= inactive
	}
	st.MemMb = float64(mem) / (1024 * 1024)
	st.MemLimitMb = float64(sample.MemoryStats.Limit) / (1024 * 1024)
	for _, n := range sample.Networks {
		st.Rx += n.RxBytes
		st.Tx += n.TxBytes
	}
	return st, nil
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// ---- helpers ------------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONBytes(w http.ResponseWriter, b []byte) {
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write(b)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeDockerError(w http.ResponseWriter, err error) {
	var ue *upstreamError
	if errors.As(err, &ue) {
		status := http.StatusBadGateway
		if ue.status == http.StatusNotFound {
			status = http.StatusNotFound
		}
		writeError(w, status, ue.msg)
		return
	}
	writeError(w, http.StatusBadGateway, fmt.Sprintf("can't reach the Docker engine: %v", err))
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func main() {
	addr := envOr("LISTEN_ADDR", defaultAddr)
	socket := envOr("DOCKER_SOCKET", defaultSocket)

	fi, err := os.Stat(socket)
	if err != nil {
		log.Fatalf("docker socket %s: %v", socket, err)
	}
	if fi.Mode()&os.ModeSocket == 0 {
		log.Fatalf("%s is not a Unix socket", socket)
	}

	s := &server{d: newDocker(socket)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /version", s.version)
	mux.HandleFunc("GET /info", s.info)
	mux.HandleFunc("GET /containers", s.listContainers)
	mux.HandleFunc("GET /containers/{id}", s.container)
	mux.HandleFunc("GET /containers/{id}/logs", s.logs)
	mux.HandleFunc("GET /stats", s.handleStats)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	log.Printf("docker proxy on http://%s → unix:%s", addr, socket)
	log.Fatal(srv.ListenAndServe())
}
