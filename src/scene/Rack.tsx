import { Billboard } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { isPreEnv, isTank, unitRole, unitTint, type UnitRole } from '../data/roles';
import type { Service } from '../data/types';
import { mb, pct } from '../format';
import { RACK, TANK, type Layout, type Slot, type V3 } from '../layout';
import { matchesSearch, useStore } from '../store';
import { ACCENT, NEON } from '../theme';
import { Label } from './Label';
import { CABINET, CABINET_DOOR, DIM_OPACITY, GEO, TANK_BODY, heatColor, ledMaterial } from './materials';

const LED_ROWS = [0.36, 0.62, 0.88, 1.14, 1.4];
const BASE_Y = 0.03; // building slab height

export const unitHeight = (svc: Service) => {
  const role = unitRole(svc);
  if (isTank(role)) return 0.08 + TANK.h + TANK.r * 0.35;
  if (role === 'proxy') return 1.05;
  if (role === 'auth') return RACK.h + 0.45;
  if (role === 'frontend' || role === 'backend' || role === 'api') return RACK.h + 0.35;
  return RACK.h + (role === 'worker' ? 0.22 : 0.06);
};

/** One service in the scene: wiring (data, pointer events) around a dumb Cabinet / Tank. */
export const ServiceUnit = memo(function ServiceUnit({ slot }: { slot: Slot }) {
  const id = slot.serviceId;
  const svc = useStore((s) => s.services[id]);
  const project = useStore((s) => s.projects[slot.projectId]);
  const env = useStore((s) => s.environments[slot.environmentId]);
  const search = useStore((s) => s.search);
  const heatmap = useStore((s) => s.heatmap);

  if (!svc) return null;
  const dim = !matchesSearch(svc, project, search, env);
  const role = unitRole(svc);

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    useStore.getState().hover(id);
    document.body.style.cursor = 'pointer';
  };
  const out = () => {
    if (useStore.getState().hoveredId === id) useStore.getState().hover(null);
    document.body.style.cursor = '';
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    useStore.getState().select(id);
  };

  return (
    <group position={[slot.pos[0], BASE_Y, slot.pos[2]]} onPointerOver={over} onPointerOut={out} onClick={click}>
      {isTank(role) ? (
        <Tank svc={svc} dim={dim} heat={heatmap} />
      ) : role === 'proxy' ? (
        <Gateway svc={svc} dim={dim} />
      ) : (
        <Cabinet svc={svc} role={role} dim={dim} heat={heatmap} />
      )}
      {isPreEnv(svc) && <EnvBeacon y={unitHeight(svc) + 0.02} dim={dim} />}
      {svc.status === 'error' && <ErrorBalloon y={unitHeight(svc) + 0.75} />}
    </group>
  );
});

interface UnitProps {
  svc: Service;
  dim: boolean;
  heat: boolean;
}

export function Cabinet({ svc, role, dim, heat }: UnitProps & { role: UnitRole }) {
  const body = useMemo(() => (heat ? heatColor(svc.cpu, 'cabinet') : new THREE.Color(CABINET)), [heat, svc.cpu]);
  const door = useMemo(() => (heat ? body.clone().multiplyScalar(0.8) : new THREE.Color(CABINET_DOOR)), [heat, body]);
  // `transparent` is baked into the shader program, so a dim toggle remounts the material (key).
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  const mk = dim ? 'dim' : 'solid';
  const led = ledMaterial(svc.status, dim);
  const kind = unitTint(svc);

  return (
    <group>
      <mesh geometry={GEO.rackFoot} position-y={0.025}>
        <meshStandardMaterial key={mk} color="#05080e" {...fade} />
      </mesh>
      <mesh geometry={GEO.rackBody} position-y={RACK.h / 2 + 0.03} castShadow={!dim} receiveShadow>
        <meshStandardMaterial key={mk} color={body} roughness={0.35} metalness={0.6} {...fade} />
      </mesh>
      <mesh geometry={GEO.rackLid} position-y={RACK.h + 0.06} castShadow={!dim}>
        <meshStandardMaterial
          key={mk}
          color={kind}
          emissive={kind}
          emissiveIntensity={dim ? 0.2 : 1.15}
          roughness={0.4}
          toneMapped={false}
          {...fade}
        />
      </mesh>
      <mesh geometry={GEO.rackDoor} position={[0, RACK.h / 2 + 0.03, RACK.d / 2 + 0.006]}>
        <meshStandardMaterial key={mk} color={door} roughness={0.3} metalness={0.7} {...fade} />
      </mesh>
      {LED_ROWS.map((y) => (
        <mesh key={y} geometry={GEO.rackLed} material={led} position={[0, y, RACK.d / 2 + 0.016]} />
      ))}
      {(role === 'web' || role === 'frontend' || role === 'backend' || role === 'api') && (
        <WebPanel color={kind} dim={dim} />
      )}
      {role === 'frontend' && <FrontendScreen dim={dim} />}
      {role === 'backend' && <BackendStack dim={dim} />}
      {role === 'api' && <ApiNode dim={dim} />}
      {role === 'worker' && <WorkGear color={kind} dim={dim} cpu={svc.cpu} />}
      {role === 'auth' && <AuthLock dim={dim} />}
      <ReplicaMarks count={svc.replicas} z={RACK.d / 2 + 0.2} dim={dim} />
    </group>
  );
}

export function Tank({ svc, dim, heat }: UnitProps) {
  const body = useMemo(() => (heat ? heatColor(svc.cpu, 'tank') : new THREE.Color(TANK_BODY)), [heat, svc.cpu]);
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  const mk = dim ? 'dim' : 'solid';
  const band = unitTint(svc);
  const top = 0.08 + TANK.h;

  return (
    <group>
      <mesh geometry={GEO.tankBase} position-y={0.04} receiveShadow>
        <meshStandardMaterial key={mk} color="#070b13" roughness={0.6} metalness={0.4} {...fade} />
      </mesh>
      <mesh geometry={GEO.tankBody} position-y={0.08 + TANK.h / 2} castShadow={!dim} receiveShadow>
        <meshStandardMaterial key={mk} color={body} roughness={0.28} metalness={0.75} {...fade} />
      </mesh>
      <mesh geometry={GEO.tankDome} position-y={top} scale-y={0.35} castShadow={!dim}>
        <meshStandardMaterial key={mk} color={body} roughness={0.28} metalness={0.75} {...fade} />
      </mesh>
      {[0.3, 0.55, 0.8].map((f) => (
        <mesh key={f} geometry={GEO.tankBand} position-y={0.08 + TANK.h * f}>
          <meshStandardMaterial
            key={mk}
            color="#000000"
            emissive={band}
            emissiveIntensity={dim ? 0.25 : 1.9}
            side={THREE.DoubleSide}
            toneMapped={false}
            {...fade}
          />
        </mesh>
      ))}
      <mesh geometry={GEO.tankLed} material={ledMaterial(svc.status, dim)} position-y={top + TANK.r * 0.35 + 0.02} />
    </group>
  );
}

/** Web server: two blades, a vent strip and a row of status lights on the door. */
function WebPanel({ color, dim }: { color: string; dim: boolean }) {
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  return (
    <group position={[0, RACK.h * 0.58, RACK.d / 2 + 0.018]}>
      {[-0.11, 0.11].map((y) => (
        <mesh key={y} position-y={y}>
          <boxGeometry args={[RACK.w - 0.18, 0.16, 0.02]} />
          <meshStandardMaterial color={CABINET_DOOR} roughness={0.35} metalness={0.6} {...fade} />
        </mesh>
      ))}
      {[-0.09, -0.045, 0, 0.045, 0.09].map((x) => (
        <mesh key={x} position={[x, -0.25, 0.012]}>
          <boxGeometry args={[0.018, 0.018, 0.008]} />
          <meshBasicMaterial color={color} toneMapped={false} transparent opacity={dim ? 0.2 : 0.9} />
        </mesh>
      ))}
      {[-0.02, -0.07, -0.12].map((y) => (
        <mesh key={y} position={[0, y, 0.012]}>
          <boxGeometry args={[RACK.w - 0.34, 0.012, 0.006]} />
          <meshBasicMaterial color={color} toneMapped={false} transparent opacity={dim ? 0.12 : 0.4} />
        </mesh>
      ))}
    </group>
  );
}

/** Proxy: a standing gateway gate on a flat base, with four pulsing ports. */
function Gateway({ svc, dim }: { svc: Service; dim: boolean }) {
  const color = unitTint(svc);
  const still = useStore((s) => s.reducedMotion);
  const outer = useRef<THREE.Mesh>(null);
  const inner = useRef<THREE.Mesh>(null);
  const ports = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (still) return;
    if (outer.current) outer.current.rotation.y = t * 0.6;
    if (inner.current) inner.current.rotation.y = -t * 0.9;
    if (ports.current) ports.current.scale.setScalar(0.75 + 0.25 * Math.sin(t * 3));
  });

  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  const portsAt: V3[] = [
    [-0.4, 0.16, 0.3],
    [0.4, 0.16, 0.3],
    [-0.4, 0.16, -0.3],
    [0.4, 0.16, -0.3],
  ];

  return (
    <group>
      <mesh position-y={0.06} receiveShadow>
        <boxGeometry args={[RACK.w - 0.08, 0.12, RACK.d - 0.08]} />
        <meshStandardMaterial color={CABINET} roughness={0.55} metalness={0.4} {...fade} />
      </mesh>
      <mesh ref={outer} position-y={0.56} castShadow={!dim}>
        <torusGeometry args={[0.34, 0.045, 12, 40]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={dim ? 0.2 : 1.6}
          roughness={0.3}
          toneMapped={false}
          {...fade}
        />
      </mesh>
      <mesh ref={inner} position-y={0.56} scale={0.72}>
        <torusGeometry args={[0.34, 0.03, 10, 36]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={dim ? 0.15 : 1.1}
          roughness={0.3}
          toneMapped={false}
          {...fade}
        />
      </mesh>
      <group ref={ports}>
        {portsAt.map(([x, y, z]) => (
          <mesh key={`${x}${z}`} position={[x, y, z]}>
            <sphereGeometry args={[0.035, 10, 8]} />
            <meshBasicMaterial color={color} toneMapped={false} transparent opacity={dim ? 0.25 : 1} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Worker: a gear that turns with the CPU load. */
function WorkGear({ color, dim, cpu }: { color: string; dim: boolean; cpu: number }) {
  const ref = useRef<THREE.Group>(null);
  const still = useStore((s) => s.reducedMotion);
  useFrame((_, rawDt) => {
    if (ref.current && !still) ref.current.rotation.y += Math.min(rawDt, 0.1) * (0.5 + Math.min(5, cpu * 6));
  });
  const teeth = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  return (
    <group ref={ref} position={[0, RACK.h + 0.13, 0]}>
      <mesh rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.15, 0.03, 6, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={dim ? 0.2 : 1.1} toneMapped={false} {...fade} />
      </mesh>
      {teeth.map((a) => (
        <mesh key={a} position={[Math.cos(a) * 0.19, 0, Math.sin(a) * 0.19]}>
          <boxGeometry args={[0.055, 0.05, 0.055]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={dim ? 0.15 : 0.9} toneMapped={false} {...fade} />
        </mesh>
      ))}
    </group>
  );
}

/** Auth / security: a gold padlock on the roof, deliberately not the lid colour. */
const LOCK = '#ffc53d';

function AuthLock({ dim }: { dim: boolean }) {
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  return (
    <group position={[0, RACK.h + 0.16, 0]}>
      {/* shackle */}
      <mesh position={[0, 0.24, 0]}>
        <torusGeometry args={[0.14, 0.038, 10, 24, Math.PI]} />
        <meshStandardMaterial
          color={LOCK}
          emissive={LOCK}
          emissiveIntensity={dim ? 0.25 : 2.2}
          roughness={0.3}
          toneMapped={false}
          {...fade}
        />
      </mesh>
      {/* body */}
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.4, 0.3, 0.18]} />
        <meshStandardMaterial
          color={LOCK}
          emissive={LOCK}
          emissiveIntensity={dim ? 0.2 : 1.5}
          roughness={0.35}
          toneMapped={false}
          {...fade}
        />
      </mesh>
      {/* keyhole */}
      <mesh position={[0, 0.07, 0.095]}>
        <circleGeometry args={[0.04, 16]} />
        <meshBasicMaterial color="#03060c" toneMapped={false} transparent opacity={dim ? 0.5 : 1} />
      </mesh>
    </group>
  );
}

/** Roof symbols are gold, so they never disappear into the lid colour. */
const SYMBOL = '#ffc53d';

/** Frontend: a small monitor with a dark frame and a gold screen. */
function FrontendScreen({ dim }: { dim: boolean }) {
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  return (
    <group position={[0, RACK.h + 0.04, 0]}>
      <mesh position-y={0.09}>
        <cylinderGeometry args={[0.03, 0.05, 0.18, 10]} />
        <meshStandardMaterial color={CABINET_DOOR} roughness={0.4} metalness={0.6} {...fade} />
      </mesh>
      <mesh position={[0, 0.29, 0]} rotation-x={-0.35} castShadow={!dim}>
        <boxGeometry args={[0.5, 0.32, 0.04]} />
        <meshStandardMaterial color="#0b111c" roughness={0.4} metalness={0.6} {...fade} />
      </mesh>
      <mesh position={[0, 0.29, 0.024]} rotation-x={-0.35}>
        <boxGeometry args={[0.42, 0.24, 0.006]} />
        <meshStandardMaterial
          color={SYMBOL}
          emissive={SYMBOL}
          emissiveIntensity={dim ? 0.3 : 1.9}
          toneMapped={false}
          {...fade}
        />
      </mesh>
    </group>
  );
}

/** Backend: three stacked gold server slabs with front LEDs. */
function BackendStack({ dim }: { dim: boolean }) {
  const fade = { transparent: dim, opacity: dim ? DIM_OPACITY : 1 };
  return (
    <group position={[0, RACK.h + 0.02, 0]}>
      {[0, 1, 2].map((i) => (
        <group key={i} position-y={0.1 + i * 0.085}>
          <mesh castShadow={!dim}>
            <boxGeometry args={[0.44 - i * 0.04, 0.06, 0.3]} />
            <meshStandardMaterial
              color={SYMBOL}
              emissive={SYMBOL}
              emissiveIntensity={dim ? 0.2 : 1.6}
              roughness={0.35}
              toneMapped={false}
              {...fade}
            />
          </mesh>
          {[-0.12, 0, 0.12].map((x) => (
            <mesh key={x} position={[x, 0, 0.154]}>
              <boxGeometry args={[0.03, 0.018, 0.006]} />
              <meshBasicMaterial color="#3a2a00" toneMapped={false} transparent opacity={dim ? 0.4 : 1} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** API: a turning gold data node. */
function ApiNode({ dim }: { dim: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const still = useStore((s) => s.reducedMotion);
  useFrame(({ clock }) => {
    if (ref.current && !still) ref.current.rotation.y = clock.elapsedTime * 1.2;
  });
  return (
    <mesh ref={ref} position={[0, RACK.h + 0.22, 0]} castShadow={!dim}>
      <octahedronGeometry args={[0.2, 0]} />
      <meshStandardMaterial
        color={SYMBOL}
        emissive={SYMBOL}
        emissiveIntensity={dim ? 0.2 : 1.9}
        roughness={0.3}
        flatShading
        toneMapped={false}
        transparent
        opacity={dim ? DIM_OPACITY : 1}
      />
    </mesh>
  );
}

/** Dev / test / staging: a small rotating warning beacon. */
function EnvBeacon({ y, dim }: { y: number; dim: boolean }) {
  const still = useStore((s) => s.reducedMotion);
  const dome = useRef<THREE.Group>(null);
  const light = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (dome.current && !still) dome.current.rotation.y = t * 2.4;
    if (light.current) light.current.emissiveIntensity = dim ? 0.3 : 1.1 + (0.5 + 0.5 * Math.sin(t * 6));
  });

  return (
    <group position={[0.34, y, -0.3]}>
      <mesh position-y={0.05}>
        <cylinderGeometry args={[0.055, 0.07, 0.1, 12]} />
        <meshStandardMaterial
          color="#1a1f2b"
          roughness={0.6}
          metalness={0.4}
          transparent
          opacity={dim ? DIM_OPACITY : 1}
        />
      </mesh>
      <group ref={dome} position-y={0.12}>
        <mesh>
          <sphereGeometry args={[0.07, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial
            ref={light}
            color="#ff9f1a"
            emissive="#ff9f1a"
            emissiveIntensity={1.6}
            toneMapped={false}
            transparent
            opacity={dim ? DIM_OPACITY : 1}
          />
        </mesh>
        <mesh position={[0, -0.005, 0.07]}>
          <boxGeometry args={[0.08, 0.02, 0.02]} />
          <meshBasicMaterial color="#ffcf6b" toneMapped={false} transparent opacity={dim ? 0.3 : 1} />
        </mesh>
      </group>
    </group>
  );
}

function ReplicaMarks({ count, z, dim }: { count: number; z: number; dim: boolean }) {
  const step = 0.17;
  const x0 = (-(count - 1) * step) / 2;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} geometry={GEO.replica} position={[x0 + i * step, 0.012, z]} rotation-x={-Math.PI / 2}>
          <meshBasicMaterial color={NEON} toneMapped={false} transparent opacity={dim ? 0.12 : 0.9} />
        </mesh>
      ))}
    </>
  );
}

function ErrorBalloon({ y }: { y: number }) {
  const ref = useRef<THREE.Group>(null);
  const still = useStore((s) => s.reducedMotion);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = still ? y : y + Math.sin(clock.elapsedTime * 2.4) * 0.09;
  });
  return (
    <group ref={ref} position-y={y}>
      <Billboard>
        <mesh scale={[1, 1.12, 1]}>
          <sphereGeometry args={[0.26, 24, 16]} />
          <meshStandardMaterial color="#ff2e55" emissive="#ff2e55" emissiveIntensity={1.4} roughness={0.3} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.06, 0.27]}>
          <boxGeometry args={[0.06, 0.18, 0.01]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.12, 0.27]}>
          <boxGeometry args={[0.06, 0.06, 0.01]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
        <mesh position-y={-0.32} rotation-x={Math.PI}>
          <coneGeometry args={[0.05, 0.07, 8]} />
          <meshStandardMaterial color="#c4203f" />
        </mesh>
      </Billboard>
      <mesh position-y={-0.62}>
        <cylinderGeometry args={[0.006, 0.006, 0.55, 4]} />
        <meshBasicMaterial color="#ff8aa0" toneMapped={false} />
      </mesh>
    </group>
  );
}

// ---- hover / selection ------------------------------------------------------------

function Ring({ slot, color, opacity, pulse }: { slot: Slot; color: string; opacity: number; pulse?: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const still = useStore((s) => s.reducedMotion);
  useFrame(({ clock }) => {
    if (ref.current && pulse && !still) ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * 0.04);
  });
  return (
    <mesh ref={ref} geometry={GEO.ring} position={[slot.pos[0], 0.05, slot.pos[2]]} rotation-x={-Math.PI / 2}>
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function HoverTip({ slot }: { slot: Slot }) {
  const svc = useStore((s) => s.services[slot.serviceId]);
  if (!svc) return null;
  return (
    <Label position={[slot.pos[0], unitHeight(svc) + 0.45, slot.pos[2]]} zIndex={12}>
      <div className="tip">
        <strong>{svc.name}</strong>
        <span>CPU {pct(svc.cpu)}</span>
        <span>{mb(svc.memMb)}</span>
      </div>
    </Label>
  );
}

/** Spinning diamond above the selected unit; floor rings get hidden behind the row in front. */
function SelectPin({ slot }: { slot: Slot }) {
  const svc = useStore((s) => s.services[slot.serviceId]);
  const still = useStore((s) => s.reducedMotion);
  const ref = useRef<THREE.Group>(null);
  const y = svc ? unitHeight(svc) + (svc.status === 'error' ? 1.7 : 0.75) : 2.4;
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.position.y = still ? y : y + Math.sin(t * 2.6) * 0.07;
    if (!still) ref.current.rotation.y = t * 1.6;
  });
  return (
    <group ref={ref} position={[slot.pos[0], y, slot.pos[2]]}>
      <mesh scale={[1, 1.6, 1]}>
        <octahedronGeometry args={[0.24, 0]} />
        <meshStandardMaterial color={NEON} emissive={NEON} emissiveIntensity={1.6} roughness={0.3} flatShading toneMapped={false} />
      </mesh>
    </group>
  );
}

export function Markers({ layout }: { layout: Layout }) {
  const hoveredId = useStore((s) => s.hoveredId);
  const selectedId = useStore((s) => s.selectedId);
  const hovered = hoveredId ? layout.slots[hoveredId] : undefined;
  const selected = selectedId ? layout.slots[selectedId] : undefined;
  return (
    <>
      {selected && <Ring slot={selected} color={NEON} opacity={0.95} pulse />}
      {selected && <SelectPin slot={selected} />}
      {hovered && hovered !== selected && <Ring slot={hovered} color={ACCENT} opacity={0.6} />}
      {hovered && <HoverTip slot={hovered} />}
    </>
  );
}
