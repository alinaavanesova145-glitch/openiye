# IYE — Systematics & Schematic Working Document
## How Every System, Flow, and Process Works

**Company:** IYE (openiye.com)
**Document Type:** Technical and Operational Systematics
**Version:** 1.0 — Engineering & Strategy Edition
**Date:** May 2026

---

> "A system is only as clear as the diagram that explains it.
>  IYE renders systems visible — and this document renders IYE visible."

---

## Table of Contents

1.  System Overview — The Master Diagram
2.  The Data Ingestion Pipeline
3.  The Computation Engine — How the Sphere Is Built
4.  The Rendering Pipeline — From Geometry to Light
5.  The Python SDK — Internal Architecture
6.  The Sharing and State System
7.  The Real-Time Streaming System
8.  The Security and Data Governance System
9.  The Enterprise Deployment Architecture
10. The User Interaction System
11. The Organizational Operating System
12. The Go-To-Market System
13. The Revenue and Finance System
14. The Product Development System
15. The Feedback Loop System
16. System Integration Map
17. Appendix A — Glossary
18. Appendix B — Key Engineering Decisions

---

## 1. System Overview — The Master Diagram

IYE is not a single product. It is a system of systems — each precisely
defined, each interfacing with the others through clear protocols.

### 1.1 The Three Primary System Layers

**Layer 1 — The Data Layer**
Everything before the user sees the sphere. Data enters IYE, is validated,
processed, mathematically transformed, and converted into a geometry
specification. Invisible to the user. Must be perfect.

**Layer 2 — The Perception Layer**
Everything the user experiences: the sphere rotating, the interaction,
the annotation, the sharing. Entirely visible. Must be flawless.

**Layer 3 — The Business Layer**
Everything that sustains and grows IYE: the GTM motion, the revenue engine,
the product development cycle, the organizational structure.
Invisible to the user. Must be intentional.

### 1.2 Master System Flow

```
USER DATA
    |
    v
[INGESTION GATE]
    |-- Format detect
    |-- Validate (6 checks)
    |-- Normalize (standardize + L2)
    |-- Serialize (msgpack)
    |
    v
[COMPUTATION ENGINE]
    |-- Algorithm selection (UMAP / t-SNE / PCA / Autoencoder)
    |-- Dimensionality reduction to 3D
    |-- Cluster detection (HDBSCAN / K-Means)
    |-- Outlier scoring (LOF)
    |-- Geometry specification generation
    |
    v
[GEOMETRY CACHE]  (S3 + ElastiCache, keyed by dataset hash, 24h TTL)
    |
    v
[STREAMING LAYER]  (WebSocket / HTTP2 push to browser)
    |
    v
[THREE.JS RENDERER]
    |-- BufferGeometry point cloud construction
    |-- Custom GLSL shaders (bloom, glow, depth-of-field)
    |-- Post-processing stack (Bloom > Bokeh > Film)
    |-- Physics engine (rotation momentum, zoom inertia)
    |
    v
[SPHERE OF TRUTH — the user sees, rotates, explores]
    |
    v
[INTERACTION LAYER]
    |-- Drag / scroll / double-click / hover / right-click
    |-- Selection and cluster isolation
    |-- Annotation (spatially embedded in 3D space)
    |-- URL state encoding (camera + selection + filter + annotations)
    |
    v
[SHARING SYSTEM]
    |-- Shareable link generated from URL state
    |-- Link analytics: open events per domain
    |-- Domain cluster alert -> CRM (HubSpot) -> Sales team
    |
    v
[ENTERPRISE CONVERSION]
    |-- Champion identified (analyst who shared)
    |-- Demo -> Security review -> Contract
```

This is the spine of IYE. Every subsystem below is a deep expansion
of one node in this master flow.

---

## 2. The Data Ingestion Pipeline

Design principles: accept everything, trust nothing,
output a clean normalized tensor.

### 2.1 Supported Input Formats

**Entry Point A — Python SDK**

```python
import iye
iye.show(data)  # data may be:
# numpy.ndarray        shape (N, D)
# pandas.DataFrame     numerical columns
# torch.Tensor
# tensorflow.Tensor
# list of lists        auto-converted
# HuggingFace Dataset
# path string          .csv / .parquet / .feather / .json
```

**Entry Point B — Web Interface**
- Drag-and-drop: .csv .json .parquet .feather
- Direct URL (public dataset links)
- API connectors: PostgreSQL, BigQuery, Snowflake (V2)

### 2.2 Six-Step Pipeline

**Step 1 — Format Detection**
MIME type (web), file extension, or Python object type is inspected.
A format adapter is selected from the registry.

**Step 2 — Deserialization**
Input converted to a structured dict:
- data_matrix  : np.float32 array shape (N, D)
- metadata     : row-level labels / IDs / timestamps
- source_format: detected format string
- timestamp    : UTC ingestion time

**Step 3 — Validation Gate (6 checks in sequence)**

| # | Check | Failure Action |
|---|-------|---------------|
| 1 | N >= 10, D >= 2 | Reject with SHAPE_ERROR |
| 2 | All values numeric and finite | Reject with INFINITE_VALUES |
| 3 | N x D within tier limit | Reject with SIZE_LIMIT |
| 4 | No zero-variance columns | Drop column, emit warning |
| 5 | Duplicate row ratio | Flag, continue |
| 6 | D > 1000 | Emit pre-reduction advisory |

**Step 4 — Normalization**
Stage 1: Column-wise standardization (zero mean, unit variance)
Stage 2: Global L2 normalization per row vector

**Step 5 — Metadata Binding**
Row metadata bound as parallel array to normalized matrix.
Surfaced when user hovers individual sphere nodes.

**Step 6 — Ingestion Record**
Log: format, (N, D), normalization params, validation results, timing.

### 2.3 Structured Error Format

```json
{
  "error_code": "VALIDATION_INFINITE_VALUES",
  "affected_columns": ["col_7", "col_23"],
  "affected_rows": 14,
  "suggestion": "Run iye.clean(data) to auto-handle.",
  "docs_url": "openiye.com/docs/errors/infinite-values"
}
```

### 2.4 Format Adapter Architecture

```python
class BaseAdapter:
    def detect(self, obj) -> bool: ...
    def to_matrix(self, obj) -> np.ndarray: ...
    def to_metadata(self, obj) -> dict: ...

class PandasAdapter(BaseAdapter):
    def detect(self, obj):
        return isinstance(obj, pd.DataFrame)
    def to_matrix(self, obj):
        cols = obj.select_dtypes(include=[np.number]).columns
        return obj[cols].values.astype(np.float32)
    def to_metadata(self, obj):
        return dict(enumerate(obj.to_dict("records")))
```

Adding a new format = implementing three methods.
The registry is auto-scanned at startup.

### 2.5 iye.clean() — The Pre-Processing Helper

```python
cleaned = iye.clean(
    data,
    nan_fill    = "mean",   # "mean" | "median" | "zero" | float
    inf_strategy= "clip",   # "clip" | "drop" | "zero"
    dedup       = True,
    low_variance= 0.0
)
```

Returns cleaned array without modifying original (immutable contract).
Logs: rows modified, columns affected, transformations applied.

---

## 3. The Computation Engine — How the Sphere Is Built

This is IYE's core intellectual property. It converts a normalized
(N, D) matrix into the geometry specification that drives the sphere.

### 3.1 Algorithm Selection — Automatic Decision Tree

IYE never asks the user to choose. The engine selects automatically.

```
Is D <= 50?
  YES ──> PCA           (fast, globally preserving)
  NO
    Is N <= 5,000?
      YES ──> t-SNE     (max local fidelity, feasible cost)
      NO
        Is N <= 500,000?
          YES ──> UMAP  (best local + global balance — IYE default)
          NO
            Is D <= 256?
              YES ──> Parametric UMAP  (GPU-accelerated)
              NO  ──> Autoencoder projection
```

**Algorithm Performance Profiles**

| Algorithm        | Local Fidelity | Global Fidelity | Speed    |
|-----------------|---------------|----------------|----------|
| PCA             | Medium        | High           | Very Fast|
| t-SNE           | Very High     | Low            | Medium   |
| UMAP (default)  | High          | Medium-High    | Fast     |
| Parametric UMAP | High          | Medium         | Fast/GPU |
| Autoencoder     | High          | High           | Slow     |

Returning datasets: cached projection model applied incrementally.
Computation time reduced by 90%+ on repeat calls.

### 3.2 UMAP in Detail — Two Phases

**Phase 1 — Graph Construction**
For each point, k nearest neighbors are computed (default k=15).
A weighted graph is built: edge weights = probability two points
are connected in the underlying manifold. Captures local topology.

**Phase 2 — Low-Dimensional Embedding**
Stochastic gradient descent minimizes cross-entropy between the
high-dimensional fuzzy topological structure and a 3D representation.
Finds the 3D layout that best preserves neighborhood structure.

**IYE Proprietary Modifications to UMAP:**

1. Perceptual optimization: post-processing maximizes visual cluster
   separation in 3D without distorting mathematical relationships.

2. Density-preserving mode (densmap): for datasets where density
   carries semantic meaning (risk concentrations, embedding populations).

3. Repulsion scaling: global repulsion tuned for spherical (not planar)
   final layouts — renders far better in 3D environments.

### 3.3 Cluster Detection — HDBSCAN

Runs on the 3D coordinates (not original N-D space).
This ensures visual clusters = system-labeled clusters.

**Why HDBSCAN:**
- No a-priori cluster count required
- Arbitrary cluster shapes supported
- Robust noise handling (noise = cluster -1)
- Per-point cluster membership probability

**Cluster output per node:**

| Field               | Type    | Description                          |
|--------------------|---------|--------------------------------------|
| cluster_id         | int     | -1 for noise/outlier                 |
| cluster_probability| float   | 0.0 – 1.0 membership confidence      |
| cluster_color_offset| int    | HSL offset from base Blush Pink      |

Fallback to K-Means (elbow method) when HDBSCAN yields > 20 clusters,
indicating continuous structure rather than discrete groupings.

### 3.4 Outlier Scoring — Local Outlier Factor

LOF computes, for each point, the ratio of the average local density
of its k-nearest neighbors to its own local density.

LOF score ~ 1.0  →  typical point (same density as neighbors)
LOF score > 2.0  →  significant outlier (sparser than neighbors)

**Outlier output per node:**

| Field           | Type  | Description                              |
|----------------|-------|------------------------------------------|
| outlier_score  | float | 1.0 = typical; >2.0 = significant outlier|
| luminosity_boost| float| Outliers rendered slightly brighter      |

### 3.5 The Geometry Specification — Final Output

```json
{
  "spec_version": "1.0",
  "node_count": 12847,
  "algorithm_used": "UMAP",
  "processing_time_ms": 843,
  "nodes": [
    {
      "id": "node_0",
      "x": 0.342,
      "y": -1.201,
      "z": 0.887,
      "cluster_id": 2,
      "cluster_probability": 0.94,
      "outlier_score": 1.02,
      "luminosity": 0.78,
      "metadata_ref": "row_0"
    }
  ],
  "clusters": [
    {
      "id": 2,
      "centroid": [0.31, -1.18, 0.79],
      "size": 847,
      "color_offset": 12
    }
  ],
  "scene_bounds": {
    "x_min": -3.2, "x_max": 3.2,
    "y_min": -2.8, "y_max": 3.1,
    "z_min": -3.0, "z_max": 3.0
  }
}
```

No raw data in this output — only rendering instructions.
Cached server-side by dataset hash. 24-hour TTL by default.
Enterprise customers may pin specs indefinitely.

---

## 4. The Rendering Pipeline — From Geometry to Light

### 4.1 Three.js Scene Construction (6 Steps)

1. Scene + camera init (OLED black #000000, perspective cam at z=5)
2. BufferGeometry build (positions / colors / sizes as Float32Arrays)
3. Custom GLSL shader compile and attach
4. Post-processing stack init (Bloom > Bokeh > Film)
5. Physics system init (rotation momentum, zoom inertia)
6. Event binding (mouse, scroll, keyboard, touch)

### 4.2 Custom Shader Architecture

**Vertex Shader — Depth-Scaled Point Size**

```glsl
attribute float size;
varying vec3 vColor;

void main() {
  vColor = color;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (300.0 / -mvPos.z);
  gl_Position  = projectionMatrix * mvPos;
}
```

Points further from camera appear smaller: correct depth perception.
Outlier nodes have larger base size — naturally draw the eye.

**Fragment Shader — Soft-Edged Bloom Disc**

```glsl
varying vec3 vColor;

void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float alpha = 1.0 - smoothstep(0.3, 0.5, d);
  gl_FragColor = vec4(vColor * (1.0 + alpha * 0.4), alpha);
}
```

Each node renders as a soft disc — brighter center, transparent edge.
Dense cluster regions aggregate into a natural glow without separate pass.

### 4.3 Post-Processing Stack

| Pass          | Settings                        | Purpose                       |
|--------------|--------------------------------|-------------------------------|
| RenderPass   | —                              | Base scene to off-screen buffer|
| UnrealBloom  | threshold 0.4 / strength 0.8  | Halo around dense cluster regions|
| BokehPass    | focus on sphere centroid       | Void appears blurred, sphere sharp|
| FilmPass     | noiseIntensity 0.05            | Tactile film grain on final image|

### 4.4 Navigation Physics

**Rotation (drag):**
Angular velocity accumulates from cursor displacement on drag.
On release: omega *= 0.95 per frame  (~3 second coast from fast drag).
Formula: omega_next = omega_current * damping_coefficient

**Zoom (scroll):**
Scroll modifies camera.fov, not camera.position.z.
Range: 20° to 90°. FoV zoom = cinematic depth effect.

**Focus (double-click):**
1-second Bezier camera transition — orbit target moves to node.
Implemented via TWEEN.js. Feel: "flying into" the cluster.

**Auto-rotation (idle):**
Activates after 3 seconds of inactivity: 0.2°/frame around Y-axis.
Activates motion-parallax depth cue without any user effort.

### 4.5 Performance Architecture

| Metric                  | Target   | Method                        |
|------------------------|----------|-------------------------------|
| Frame rate             | 60 fps   | BufferGeometry, typed arrays  |
| First render (post-receive)| <100ms | Pre-compiled shaders + GPU upload|
| Max smooth node count  | 2,000,000| LOD octree system             |
| Memory at 1M nodes     | <200 MB  | Float32, no heap allocations  |

**Level-of-Detail (LOD) System:**
Datasets > 500K nodes: spatial octree groups nodes into cells.
Default zoom: cell centroids rendered only.
Zoom in: individual nodes within focused cell progressively revealed.
Maintains 60fps at any scale and any dataset size.

---

## 5. The Python SDK — Internal Architecture

The SDK is IYE's primary entry point and most strategically important artifact.

### 5.1 Package Structure

```
iye/
├── __init__.py           Public API: show() clean() snapshot() config()
├── client.py             HTTP client, auth, API communication
├── ingest.py             Local validation and serialization
├── formats/
│   ├── numpy_adapter.py
│   ├── pandas_adapter.py
│   ├── torch_adapter.py
│   ├── tensorflow_adapter.py
│   ├── huggingface_adapter.py
│   └── file_adapter.py   CSV / Parquet / Feather / JSON
├── schema.py             Pydantic request and response models
├── browser.py            Browser window management (webbrowser + subprocess)
├── config.py             API key management (~/.iye/credentials.json)
├── errors.py             Structured IYEError hierarchy
└── utils.py              Logging, optional telemetry, helpers
```

### 5.2 iye.show() — Internal Execution Sequence

```
Step | Action                        | Typical Duration
-----|-------------------------------|------------------
1    | ingest.detect_format(data)    | ~1 ms
2    | ingest.validate(data)         | ~5 ms
3    | ingest.normalize(data)        | ~50 ms  (NumPy vectorized)
4    | ingest.serialize(data)        | ~20 ms  (msgpack binary)
5    | client.upload(serialized)     | ~200 ms (network + receive)
6    | [SERVER computation]          | ~500 ms
7    | client.receive(geometry_url)  | ~10 ms
8    | browser.open(geometry_url)    | ~50 ms
     | TOTAL TARGET                  | < 1000 ms
```

### 5.3 Authentication — First-Run Flow

```
No API key configured?
    |
    v
Open browser to openiye.com/quickstart
    |
    v
Generate temporary session token (24h, free tier)
    |
    v
Store at ~/.iye/credentials.json
    |
    v
All subsequent calls use stored token automatically
```

Enterprise configuration:
```python
import iye
iye.config(api_key="iye_enterprise_xxxxxxxxxxxx")
# or: export IYE_API_KEY=iye_enterprise_xxxxxxxxxxxx
```

### 5.4 Extended SDK API

```python
# Label individual nodes by row
iye.show(data, labels=["customer_A", "customer_B", ...])

# Highlight specific node indices
iye.show(data, highlight=[42, 137, 891])

# Override color palette
iye.show(data, palette="midnight")

# Export 4K static snapshot
iye.snapshot(data, path="sphere.png",
             resolution=(3840, 2160),
             rotation=(45, 30, 0))

# Auto-clean before visualizing
iye.show(iye.clean(data))

# Real-time streaming mode
with iye.stream() as sphere:
    while True:
        sphere.update(fetch_latest())
        time.sleep(1.0)
```

All options are additive. iye.show(data) is always the complete API.
No option is ever required. Defaults are always the best choice.

### 5.5 Error Hierarchy

```
IYEError
├── IYEIngestionError     data format and validation problems
├── IYENetworkError       connectivity and timeout issues
├── IYEAuthError          API key problems
├── IYEComputationError   server-side processing failure
└── IYERenderError        browser launch failure
```

Each error: error_code, human_readable_message, suggested_fix, docs_url.
Raw Python tracebacks are never surfaced to the user.

---

## 6. The Sharing and State System

### 6.1 URL State Encoding

Every visualization state is encoded in the URL. No server-side session state.

```
openiye.com/v/{spec_id}#{state}

{state} = base64url( JSON({
  "camera":     { "theta": 1.23, "phi": 0.45, "fov": 60 },
  "selection":  [42, 137, 891],
  "filter":     { "cluster": [0, 2], "outlier_min": 1.5 },
  "annotations": [
    { "node_id": 42, "text": "Risk peak", "author": "analyst_01" }
  ]
}) )
```

Properties:
- URL is a complete, self-contained state description
- No login required to view a shared URL  (read-only, free)
- URL is stable for 24h (enterprise: pin indefinitely)
- Works in email, Slack, Notion, Git comments, anywhere

### 6.2 The Sharing Flow

```
Analyst finishes exploring sphere
    |
    v
Copies URL from browser address bar — zero friction
    |
    v
Pastes link in email / Slack / meeting chat
    |
    v
Recipient clicks link
    |
    v
Sphere loads at EXACT analyst state:
  same rotation / same zoom / same selected nodes
  same filter / same annotations
    |
    v
Recipient explores from exactly where analyst left off
```

### 6.3 Collaborative Annotation

Annotations are spatially embedded in 3D space — not 2D screen overlays.

| Field  | Type   | Description                         |
|--------|--------|-------------------------------------|
| node_id| string | 3D attachment point                 |
| text   | string | max 500 characters                  |
| author | string | collaborator identifier             |
| ts     | UTC    | creation timestamp                  |
| scope  | enum   | personal / team / public            |

Team annotations persist in the IYE annotation store, keyed by spec_id.
Multiple collaborators see each other's annotations in real time.

### 6.4 Link Analytics — The Enterprise Sales Signal

Every link-open event logged server-side:
```json
{
  "spec_id":  "abc123",
  "viewer_domain": "bridgewater.com",
  "viewer_ip_hash": "sha256_of_ip",
  "opens_from_domain": 7,
  "first_open": "2026-05-10T14:22:00Z",
  "last_open":  "2026-05-10T22:51:00Z"
}
```

Trigger: opens_from_domain > 5 for a corporate domain
→ Domain Alert fires to HubSpot CRM
→ Sales team sees warm enterprise prospect in real time
→ AE reaches out with reference to the specific shared sphere

---

## 7. The Real-Time Streaming System

### 7.1 Streaming Architecture

```
Live Data Source
(portfolio feed / production model / logistics network)
    |
    v
IYE Streaming Connector (Python context manager)

    with iye.stream() as sphere:
        while True:
            sphere.update(fetch_latest())
            time.sleep(1.0)

    |
    v
IYE Streaming API (FastAPI WebSocket endpoint /ws/stream)
    |
    v
Incremental Computation Engine
    |-- New node    : UMAP transform (no full refit) + LOF score
    |-- Updated node: recompute position using cached projection model
    `-- Removed node: mark for deletion
    |
    v
Delta Geometry Packet
(only changed nodes transmitted — not full spec)
    |
    v
WebSocket push to all connected browsers
    |
    v
Three.js scene updated incrementally
    |-- New nodes    : fade in from 0 opacity over 400 ms
    |-- Moving nodes : animate old → new position over 800 ms
    `-- Removed nodes: fade out over 400 ms then deleted
```

### 7.2 Streaming Performance Targets

| Metric                        | Target   |
|------------------------------|----------|
| Minimum update cadence        | 100 ms   |
| Maximum update cadence        | 60 s     |
| Delta packet (10K nodes)      | ~200 KB  |
| WebSocket latency p95         | <50 ms   |
| Concurrent sessions/enterprise| Unlimited|

---

## 8. The Security and Data Governance System

### 8.1 The Ephemeral Contract

Raw data **never** persists on IYE servers. Strict sequence:

```
1. Raw data arrives at ingestion endpoint
2. Validated and normalized in-memory
3. Computation produces geometry specification
4. Raw data immediately zeroed from memory
5. Geometry specification stored (coordinates + metadata, not raw data)
6. After 24 hours, geometry specification deleted (unless pinned)
```

Enterprise zero-retention mode: geometry spec deleted immediately
after the browser renders the first frame.

### 8.2 Encryption Architecture

| Layer               | Method                              |
|--------------------|-------------------------------------|
| Data in transit     | TLS 1.3, cert pinned in SDK         |
| Data in processing  | In-memory only, process-isolated    |
| Geometry at rest    | AES-256-GCM, per-customer key       |
| Shareable link IDs  | 128-bit cryptographically random    |

### 8.3 Authentication Architecture

| Method              | Scope                               |
|--------------------|-------------------------------------|
| API Key (HMAC)      | SDK authentication                  |
| OAuth 2.0 + PKCE    | Web app (Google / Microsoft / Okta) |
| SAML 2.0 / OIDC     | Enterprise SSO                      |
| Service Account     | CI/CD pipeline integrations         |

### 8.4 Authorization Role Model

| Role       | Permissions                                        |
|-----------|---------------------------------------------------|
| Viewer    | Open shared links, read-only                       |
| Creator   | Create and share visualizations                    |
| Annotator | Creator + write team-scoped annotations            |
| Admin     | Full workspace, billing, SSO, user management      |

### 8.5 Compliance Roadmap

| Standard      | Status                                 |
|--------------|----------------------------------------|
| GDPR          | Compliant Day 1 (ephemeral processing) |
| CCPA          | Compliant Day 1                        |
| SOC 2 Type II | Roadmap: Month 6                       |
| HIPAA         | Private deployment + BAA               |
| ISO 27001     | Roadmap: Month 18                      |

---

## 9. The Enterprise Deployment Architecture

### 9.1 Three Deployment Modes

**Mode 1 — Cloud (Default)**
IYE-managed on AWS primary, GCP failover.
Computation: Lambda + ECS (auto-scaling 1–100 containers).
Storage: S3 encrypted geometry specs.
CDN: CloudFront for static assets and spec delivery.

**Mode 2 — VPC Injection**
IYE computation layer deployed in customer's AWS/GCP/Azure account.
Raw data never leaves customer cloud environment.
IYE manages deployment via Terraform modules.
Appropriate for: large financial institutions, regulated enterprises.

**Mode 3 — Air-Gapped On-Premises**
Full IYE stack on customer hardware. No external connections required.
Annual license. No telemetry. IYE provides offline software updates.
Appropriate for: defense, intelligence, maximum-security finance.

### 9.2 Cloud Scalability Architecture

```
API Gateway (AWS)
    |
    v
Job Queue (SQS)
    |
    v
Computation Workers (ECS Fargate)
    Auto-scale: 1 to 100 containers
    |
    v
Result Store (S3 + ElastiCache hot cache)
    |
    v
WebSocket Server (API Gateway WebSocket API)
```

Capacity targets:
- 10,000 simultaneous computation jobs
- 500 ms median time for datasets up to 100K vectors
- 99.9% uptime SLA (enterprise tier)

### 9.3 Disaster Recovery

| Metric | Target  |
|--------|---------|
| RPO    | 1 hour  |
| RTO    | 15 min  |

Strategy:
- Geometry specs replicated to S3 in secondary region
- Computation fleet pre-warmed in secondary region
- Route 53 health-check failover (sub-60 second, automatic)
- DR runbook tested quarterly

---

## 10. The User Interaction System

### 10.1 The Six-Gesture Vocabulary

IYE limits its interaction vocabulary to exactly six gestures.

| Gesture      | Action                                          |
|-------------|------------------------------------------------|
| Drag        | Rotate the sphere                               |
| Scroll      | Zoom in or out                                  |
| Double-click| Focus on node — camera fly-in over 1 second     |
| Hover       | Surface node metadata tooltip (200 ms delay)    |
| Right-click | Contextual menu (annotate / isolate / highlight)|
| Spacebar    | Toggle ambient auto-rotation on or off          |

No menu bar. No toolbar. No visible settings panel.
The interface is the data.

### 10.2 Metadata Tooltip Format

```
┌─────────────────────────────┐
│  NODE 4,291                 │
│  ─────────────────────────  │
│  Cluster 3  (Risk Tier A)   │
│  Outlier Score: 1.02        │
│  ─────────────────────────  │
│  BORROWER_ID_88412          │
│  income: $127,400           │
│  debt_ratio: 0.32           │
│  credit_score: 742          │
└─────────────────────────────┘
```

IYE adds cluster and outlier score. All other fields come from user metadata.
Appears 200 ms after hover. Fades out 500 ms after hover ends.

### 10.3 The Filter Panel

Accessed via F key or hover-revealed gear icon.
Glassmorphism treatment: backdrop-filter blur(20px), rgba(0,0,0,0.6).
Auto-dismisses after 5 seconds of inactivity.

Controls:
- Per-cluster visibility toggle
- Outlier threshold slider (show nodes above score X)
- Temporal range selector (time-series datasets)
- Metadata label filter (show nodes where field = value)

### 10.4 Cluster Isolation Mode

Right-click any cluster:
1. Isolate cluster — all other clusters dim to 10% opacity
2. Inspect cluster — side panel: all nodes listed, metadata sortable
3. Export cluster — downloads row indices as .csv

The inspect panel uses Quiet Luxury: dark, semi-transparent, sphere
remains visible through the glassmorphism surface behind it.

---

## 11. The Organizational Operating System

### 11.1 Founding Team Structure

```
CEO / GTM Lead
    GTM strategy / enterprise sales
    investor relations / hiring

CTO / Technical Lead
    computation engine / Python SDK
    API and backend / infrastructure

CPO / Design Lead
    Three.js frontend / Quiet Luxury system
    product roadmap / user research
```

### 11.2 First 10 Hires

| # | Role                           | Month | Rationale                       |
|---|-------------------------------|-------|---------------------------------|
| 1 | Senior ML Engineer            | 3     | Scale computation engine        |
| 2 | Enterprise AE (FinTech)       | 6     | First enterprise sales          |
| 3 | Frontend Engineer (WebGL)     | 6     | Rendering performance           |
| 4 | DevOps / Infra Engineer       | 8     | SOC 2, private deployment       |
| 5 | Enterprise AE (AI/ML)         | 9     | Second vertical coverage        |
| 6 | Customer Success Manager      | 10    | Enterprise retention            |
| 7 | Backend Engineer              | 12    | API reliability, streaming      |
| 8 | Product Designer              | 12    | Design system maintenance       |
| 9 | Head of Marketing             | 15    | Developer community growth      |
|10 | Data Scientist (Algorithms)   | 18    | Proprietary algorithm R&D       |

### 11.3 Decision Framework — RAPID

```
R — Recommend  : proposes decision with supporting analysis
A — Agree      : input must be incorporated before deciding
P — Perform    : will execute the decision
I — Input      : consulted but not required to agree
D — Decide     : single person who makes the final call
```

Applied explicitly to every significant product and architecture decision.

### 11.4 Weekly Operating Rhythm

| Meeting         | Cadence       | Duration | Participants |
|----------------|--------------|----------|--------------|
| All-Hands       | Weekly Mon    | 30 min   | All          |
| Engineering Sync| Weekly Tue    | 45 min   | Eng team     |
| Sales Pipeline  | Weekly Wed    | 30 min   | CEO + AEs    |
| Product Review  | Bi-weekly     | 60 min   | All          |
| Investor Update | Monthly       | Written  | CEO          |

---

## 12. The Go-To-Market System

### 12.1 The Full Acquisition Funnel

```
AWARENESS
    PyPI organic / HackerNews / Reddit ML+quant
    Academic citations / Sphere Stories content
        |
        v
ACTIVATION (< 10 seconds)
    pip install iye
    iye.show(my_data)
    First sphere rendered on own data
        |
        v
INDIVIDUAL RETENTION
    Pro upgrade: 5M vectors / private links / annotation
    Habitual: every new dataset goes through IYE first
        |
        v
REFERRAL (built into the product)
    Link shared to colleague or manager (zero friction)
    Manager sees sphere, asks "where do I get this?"
        |
        v
ENTERPRISE CONVERSION
    Link analytics detect domain cluster (5+ opens)
    AE outreach referencing specific shared sphere
    Demo (30 min — analyst's own data in the sphere)
    Security review (SOC 2 docs, DPA signed)
    60-day pilot on one team
    Full enterprise contract
```

### 12.2 Enterprise Sales Motion — Step by Step

```
Day 0:   Domain alert fires (5+ opens from company.com)
Day 1:   AE reviews champion's usage in CRM
Day 2:   Outreach email: "I noticed your team has been
          exploring a risk visualization —
          I'd love to show you what's possible."
Week 1:  Discovery call (30 min, champion + AE)
Week 2:  Demo (champion's own dataset, live in sphere)
Week 4:  Security review (SOC 2 docs, DPA, architecture review)
Week 6:  Pilot agreement (60 days, one team, full features)
Week 14: Pilot review + commercial negotiation
Week 18: Enterprise contract signed
```

Average cycle: 4 months (developer-seeded) vs. 12 months (cold outbound).
The Trojan Horse reduces sales cycle by 8 months on average.

### 12.3 Content Strategy — Show, Never Tell

IYE's content rule: every published piece contains a live interactive sphere.
No screenshots. No descriptions. Only the sphere itself, embedded and rotating.

| Content Type          | Description                                   |
|----------------------|-----------------------------------------------|
| Sphere Stories        | "We visualized X. Here is what we found."    |
| Sphere in the Wild    | User-submitted discoveries via IYE            |
| Technical deep-dives  | UMAP vs. t-SNE on real IYE datasets           |
| Annual State Report   | FinTech / AI-ML / Logistics editions          |

### 12.4 Developer Community Architecture

| Channel    | Platform  | Purpose                              |
|-----------|-----------|--------------------------------------|
| Discord    | Discord   | Community, bugs, showcase channel    |
| GitHub     | GitHub    | Issues, features, partial OSS SDK   |
| Stats page | openiye   | PyPI download count (social proof)   |
| Gallery    | openiye   | Curated public spheres + insights    |

---

## 13. The Revenue and Finance System

### 13.1 Pricing Architecture

| Tier           | Price         | Limit        | Purpose           |
|---------------|---------------|--------------|-------------------|
| Free           | $0 / month    | 50K vectors  | Viral seeding     |
| Individual Pro | $29 / month   | 5M vectors   | Practitioners     |
| Team           | $299 / month  | Unlimited    | Collaborative     |
| Enterprise     | $90K+ / year  | Unlimited    | Mission-critical  |

### 13.2 Unit Economics

| Metric          | Individual Pro | Team     | Enterprise |
|----------------|---------------|----------|------------|
| ACV             | $348          | $3,588   | $120,000   |
| CAC             | $15           | $800     | $18,000    |
| Gross Margin    | 75%           | 78%      | 82%        |
| CAC Payback     | 0.5 months    | 3 months | 6 months   |
| Annual Churn    | 25%           | 12%      | 5%         |
| NRR             | n/a           | 110%     | 130%       |

### 13.3 36-Month ARR Projection

| Month | Enterprise ARR | Pro+Team MRR | Total ARR    | Headcount |
|-------|---------------|--------------|-------------|-----------|
| 6     | $0            | $8,700       | $104,400    | 3         |
| 12    | $600,000      | $31,200      | $974,400    | 6         |
| 18    | $2,400,000    | $67,800      | $3,213,600  | 9         |
| 24    | $6,000,000    | $118,500     | $7,422,000  | 14        |
| 36    | $12,000,000   | $248,000     | $14,976,000 | 22        |

### 13.4 Fundraising Architecture

| Round    | Amount        | When         | Purpose                         |
|---------|--------------|--------------|--------------------------------|
| Pre-Seed | $500K–$1.5M  | Month 0      | Build V1, launch, 10K installs |
| Seed     | $4M–$8M      | Month 9–12   | Enterprise hires, SOC 2, pilot |
| Series A | $20M–$40M    | Month 24–30  | International, 100+ enterprise |

---

## 14. The Product Development System

### 14.1 Three Non-Negotiable Constraints

1. **The Sphere Is Sacred**: no feature ships if it degrades the visual quality
   or cognitive clarity of the Sphere of Truth.

2. **One-Line Must Stay One-Line**: iye.show(data) is always the complete API.
   All additional functionality is additive and optional.

3. **Discover, Not Configure**: if a feature requires a user-facing config option,
   it is not yet ready. Eliminate the option through smarter defaults first.

### 14.2 Sprint Structure — 2-Week Cycles

```
Week 1:
  Days 1–2   Architecture and design review for sprint features
  Days 3–8   Implementation
  Day 9      Internal demo and QA pass

Week 2:
  Days 10–11 Bug fixes from QA
  Day 12     Design review (CPO approval required for visual changes)
  Day 13     Staging deploy and internal use
  Day 14     Production deploy and release notes published
```

### 14.3 Feature Prioritization Scoring

| Dimension        | Weight | Question                                 |
|-----------------|--------|------------------------------------------|
| Cognitive Value  | 40%    | Does this make data more clearly visible?|
| Adoption Impact  | 35%    | Does this strengthen the viral loop?     |
| Technical Debt   | 25%    | Does this increase architectural complexity?|

Rule: features scoring < 3/5 on Cognitive Value are never built.
The product's north star is perceptual clarity — this is structural.

### 14.4 Three-Generation Feature Roadmap

**V1 — The Sphere (Launch)**
Sphere of Truth, Python SDK, web upload, shareable links,
personal annotation, cluster isolation, outlier detection, filter panel.

**V2 — The Platform (Month 12–18)**
Real-time streaming, team annotations, temporal animation,
link analytics dashboard, private deployment, BigQuery/ Snowflake connectors,
IYE Atlas (multi-sphere linked navigation).

**V3 — The Observatory (Month 24–36)**
Live Risk Observatory, IYE Marketplace, embeddable API widget,
WebGPU renderer, IYE Certified program, mobile viewer (iOS/Android).

---

## 15. The Feedback Loop System

### 15.1 The Viral Growth Loop

```
Data Scientist installs IYE
    |
    v
Runs iye.show() on real data (10 seconds of effort)
    |
    v
Sphere appears — data never seen like this before
    |
    v
Shares link with team / manager (zero friction)
    |
    v
Decision-maker asks: "What is this software?"
    |
    v
IYE sales receives domain alert
    |
    v
Enterprise contract signed
    |
    v
More analysts at the company use IYE
    |
    v
More links shared externally → more prospects detected
    |
    +------- LOOP REPEATS AND ACCELERATES --------> (back to top)
```

Velocity targets:
- First install → first sphere: < 1 minute
- First sphere → first share: < 10 minutes
- First external share → sales outreach: < 48 hours

### 15.2 The Algorithm Quality Loop

```
User submits dataset
    |
    v
Sphere rendered by computation engine
    |
    v
IYE logs quality signals:

    HIGH quality signals:
        User zooms into cluster (engaged)
        User annotates a node (very engaged)
        User shares the link (extremely satisfied)
        Session duration > 5 minutes

    LOW quality signals:
        Session < 30 seconds (not compelling)
        No interaction beyond initial load
    |
    v
Algorithm selection logic updated from quality signals
(which algorithm, which k, which post-processing for this data type)
    |
    v
Future similar datasets → better algorithm → better sphere
    |
    v
Better sphere → more sharing → more usage

    +----------- LOOP DEEPENS THE MOAT -----------> (back to top)
```

Each processed dataset improves the next similar one.
No competitor can replicate this without replicating the data history.

### 15.3 User Research Channels

**In-Product Micro-Survey**
After 5 minutes of active session: one question at bottom of screen,
never obscuring the sphere: "What are you looking for in this dataset?"
One-click dismissal. Open text response stored for product review.

**Champion Interview Program**
50 most active free-tier users → monthly 30-minute video calls.
Most likely future converters. Feedback drives Pro and Team roadmap.

**Enterprise Quarterly Business Reviews**
Every enterprise customer: 60-minute quarterly session with product team.
Structured feedback on gaps and expansion opportunities.

**Session Recording (Enterprise Opt-In)**
Heatmaps and interaction paths for opted-in workspaces.
Feeds directly into UI iteration cycle.

---

## 16. System Integration Map

### 16.1 Full Dependency Table

| System A             | System B              | Dependency                |
|---------------------|-----------------------|--------------------------|
| Python SDK          | Ingestion Pipeline    | Data serialization        |
| Ingestion Pipeline  | Computation Engine    | Normalized matrix         |
| Computation Engine  | Geometry Cache        | Spec storage              |
| Geometry Cache      | Streaming Layer       | Spec retrieval            |
| Streaming Layer     | Three.js Renderer     | Geometry push             |
| Three.js Renderer   | Interaction Layer     | Node surface              |
| Interaction Layer   | Sharing System        | URL state encoding        |
| Sharing System      | Link Analytics        | Open events               |
| Link Analytics      | CRM (HubSpot)         | Domain alerts             |
| CRM                 | Sales Team            | Prospect notification     |
| User Research       | Product Dev           | Feedback loop             |
| Revenue System      | Computation Engine    | Tier enforcement          |

### 16.2 Internal Health Dashboard

| System              | Primary Metric           | Alert Threshold |
|--------------------|--------------------------|-----------------|
| Ingestion Pipeline  | Validation error rate     | > 2%            |
| Computation Engine  | p95 computation time      | > 2000 ms       |
| Geometry Cache      | Cache hit rate            | < 40%           |
| Streaming Layer     | WebSocket disconnect rate | > 1%            |
| Three.js Renderer   | p95 first render time     | > 200 ms        |
| Sharing System      | Link 404 rate             | > 0.1%          |
| Python SDK          | Server-side error rate    | > 0.5%          |
| Enterprise Auth     | Auth failure rate         | > 0.1%          |

Metric breaches: PagerDuty alert to on-call engineer.
Enterprise SLA breach: automated customer notification + credit calculation.

### 16.3 Third-Party System Integrations

| Tool         | Purpose                    | Integration         |
|-------------|----------------------------|---------------------|
| HubSpot      | CRM, deal tracking         | API — domain alerts |
| Stripe       | Billing                    | Webhook             |
| PagerDuty    | On-call alerting           | API — health metrics|
| Intercom     | Customer success           | SDK — in-product    |
| Mixpanel     | Product analytics          | SDK — events        |
| GitHub       | SDK source, issues         | Native              |
| PyPI         | Package distribution       | Native              |
| AWS CloudWatch| Infra monitoring          | Native              |
| Sentry       | Error tracking (SDK + web) | SDK                 |

---

## Appendix A — Glossary of IYE Technical Terms

| Term                      | Definition                                               |
|--------------------------|----------------------------------------------------------|
| Sphere of Truth           | Primary 3D point-cloud output of IYE                    |
| Geometry Specification    | JSON output of computation engine (no raw data)          |
| UMAP                      | Uniform Manifold Approximation and Projection            |
| HDBSCAN                   | Hierarchical Density-Based Spatial Clustering            |
| LOF                       | Local Outlier Factor outlier detection algorithm         |
| Quiet Luxury              | IYE design philosophy: every element serves data         |
| Ephemeral Contract        | Raw data never persists — only geometry spec stored      |
| Domain Alert              | CRM trigger: 5+ opens from one corporate domain          |
| Spatial State             | Camera + selection + filter + annotations encoded in URL |
| Geometry Cache            | Server-side spec store keyed by dataset hash             |
| Trojan Horse              | Python SDK as IYE's primary GTM entry mechanism          |
| Flat Data Blindness       | Inability to perceive multi-dimensional data geometry    |
| Algorithm Moat            | Competitive advantage from improving selection logic     |
| Institutional Spatial Memory | Accumulated annotations making enterprise switching costly|
| LOD System                | Level-of-Detail octree for 60fps at 2M+ nodes            |
| Delta Geometry Packet     | Streaming update containing only changed nodes           |

---

## Appendix B — Key Engineering Decisions and Rationale

| Decision                     | Alternative Considered | Rationale                              |
|-----------------------------|----------------------|----------------------------------------|
| Three.js over Babylon.js    | Babylon.js           | Lighter, better community, point-cloud focus|
| UMAP as default             | t-SNE                | Scales to millions; t-SNE is O(N^2)    |
| HDBSCAN over DBSCAN         | DBSCAN               | No epsilon param; handles varying density|
| FastAPI over Flask          | Flask                | Async + Pydantic essential for performance|
| Ephemeral data processing   | Store raw data       | Security requirement + storage cost    |
| URL state (no server sessions)| Server sessions    | Infinitely scalable, no login required |
| Blush Pink node color       | Blue or white        | Cognitive distinction from all existing tools|
| Float32 geometry            | Float64              | Half memory; 7 sig figs sufficient     |
| FoV zoom over position zoom | Camera position zoom | More cinematic depth-change effect     |
| LOD at 500K node threshold  | Always render all    | Maintains 60fps at any dataset scale   |
| Cluster on 3D coords        | Cluster in N-D space | Visual clusters = system-labeled clusters|
| HDBSCAN → K-Means fallback  | HDBSCAN only         | K-Means better for continuous structure|
| msgpack serialization       | JSON                 | 3–5x smaller payload, faster parse     |
| Auto-rotation at idle       | Static until dragged | Activates motion parallax depth cue    |
| Fragment shader glow        | Separate bloom pass  | Single pass, no frame-buffer overhead  |

---

*IYE Systematics Document — Version 1.0*
*openiye.com — Intelligence, visualized.*
*See the unseen.*
