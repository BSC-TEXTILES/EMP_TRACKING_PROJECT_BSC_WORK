# DIAGRAMS.md — architecture and flow diagrams

All diagrams use Mermaid and render on GitHub, GitLab and most Markdown viewers.

## 1. System architecture

```mermaid
flowchart TB
  subgraph Client
    SPA[React SPA / PWA]
    SW[Service Worker cache]
  end
  subgraph Edge
    NG[nnginx · TLS · HSTS]
  end
  subgraph App["Node.js process"]
    MW[Security middleware<br/>helmet · CORS · origin guard · rate limit]
    API[REST routers]
    SVC[Domain services]
    IO[Socket.IO]
    CRON[node-cron scheduler]
    STATIC[Static SPA hosting]
  end
  DB[(MySQL 8)]
  FS[(Private uploads)]
  SMTP[SMTP]
  SMS[SMS gateway]
  TURN[TURN server]

  SPA --> NG --> MW
  MW --> API --> SVC --> DB
  MW --> IO
  SVC --> FS
  SVC --> SMTP
  SVC --> SMS
  CRON --> SVC
  SPA <-. WebRTC media .-> TURN
  IO -. signalling .-> SPA
  NG --> STATIC
```

## 2. Request pipeline

```mermaid
flowchart LR
  R[HTTP request] --> H[Helmet headers]
  H --> O[Origin guard for mutations]
  O --> L[Rate limiter]
  L --> A[Auth: JWT + session row]
  A --> P[Permission guard]
  P --> V[Zod validation]
  V --> S[Service + transaction]
  S --> J[JSON response]
  A -. fail .-> E401[401]
  P -. fail .-> E403[403]
```

## 3. Organisation hierarchy

```mermaid
flowchart TD
  SA[Super Admin / Owner] --> EX[Executive Leadership]
  EX --> GM[General Manager]
  GM --> DH[Department Head]
  DH --> M[Manager]
  M --> TL[Team Lead / Senior]
  TL --> E[Employee]
  DH --> HR[HR Manager]
  HR --> HRE[HR Executive]
  DH --> IT[IT Administrator]
  IT --> HD[Helpdesk Executive]
  M --> SM[Store Manager]
  SM --> SS[Store Staff]

  subgraph Scope
    M -. sees .-> TL
    M -. sees .-> E
    M -. cannot see .-> OTHER[Other departments]
  end
```

## 4. Attendance flow

```mermaid
sequenceDiagram
  participant E as Employee
  participant A as API
  participant D as MySQL
  E->>A: CHECK IN
  A->>D: unique(employee, work_date) insert with server time
  A-->>E: serverNow + checkInAt + elapsedSeconds
  loop heartbeat
    E->>A: GET /attendance/heartbeat
    A-->>E: authoritative elapsed
  end
  E->>A: break start / end
  E->>A: CHECK OUT
  A->>D: total minutes, overtime, status
  A-->>E: daily summary
  Note over A,D: cron auto-closes missing check-outs and flags them
```

## 5. Task lifecycle

```mermaid
stateDiagram-v2
  [*] --> assigned
  assigned --> accepted
  assigned --> rejected
  accepted --> in_progress
  in_progress --> on_hold
  on_hold --> in_progress
  in_progress --> pending_approval
  pending_approval --> completed
  pending_approval --> in_progress: changes requested
  completed --> reopened
  assigned --> overdue
  in_progress --> overdue
  assigned --> cancelled
  completed --> [*]
```

## 6. Notification architecture

```mermaid
flowchart LR
  EV[Domain event<br/>task, report, ticket, chat, meeting, KPI, leave] --> NS[NotificationService]
  NS --> N[(notifications)]
  NS --> NR[(notification_recipients)]
  NS --> EMIT[emitToEmployees]
  EMIT --> W1[Socket user room]
  W1 --> UI[Popup + badge + list]
  NS -. optional .-> MAIL[Email]
  NS -. optional .-> SMS[SMS]
  ANN[Announcement] --> RES[Resolve audience<br/>all / dept / role / location]
  RES --> NS
```

## 7. Chat real-time flow

```mermaid
sequenceDiagram
  participant S as Sender
  participant API
  participant DB
  participant R as Recipient (online)
  S->>API: POST message
  API->>DB: membership check + persist message
  API-->>S: 201 message
  API->>R: socket message:new
  R->>API: POST read
  API->>S: socket message:read
  Note over API,R: offline recipients get notifications + unread counts
```

## 8. KPI computation

```mermaid
flowchart TD
  M[Monthly metrics] --> T[Tasks: assigned/completed/on-time]
  M --> A[Attendance: %, punctuality, hours]
  M --> R[Reports: submission discipline]
  M --> K[Tickets: resolution]
  M --> Q[Manager quality + collaboration]
  T --> N[Normalise 0-100]
  A --> N
  R --> N
  K --> N
  Q --> N
  N --> W{Available?}
  W -- no --> X[Exclude + redistribute weight]
  W -- yes --> C[score × weight]
  X --> SUM[Weighted total]
  C --> SUM
  SUM --> CAT[Category + explanation]
  CAT --> REV[Manager review]
  REV --> PUB[Publish + notify + lock]
```

## 9. User journey (employee day)

```mermaid
journey
  title A working day
  section Morning
    Sign in: 4: Employee
    Check in: 5: Employee
    Review tasks: 4: Employee
  section Working
    Accept and start task: 4: Employee
    Log progress and time: 3: Employee
    Chat with team: 4: Employee
  section Evening
    Submit daily report: 4: Employee
    Check out: 5: Employee
    View KPI trend: 4: Employee
```

## 10. Deployment topology

```mermaid
flowchart LR
  U[Users] --> CDN[DNS / optional CDN]
  CDN --> NG[nnginx TLS]
  NG --> APP1[Node app instance]
  NG -. sticky WS .-> APP2[Second instance optional]
  APP1 --> MYSQL[(MySQL primary)]
  APP2 --> MYSQL
  MYSQL --> BKP[(Nightly backups)]
  APP1 --> OBJ[(Uploads volume / object storage)]
  APP1 --> MON[Logs & monitoring]
```
