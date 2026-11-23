# Builds the read-only Docker proxy (proxy/main.go) as a static binary.
FROM golang:1.27.4-alpine3.24 AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /proxy .

FROM alpine:3.24
COPY --from=build /proxy /proxy
USER nobody
EXPOSE 3101
ENTRYPOINT ["/proxy"]
