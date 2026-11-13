# client-reliability

## Purpose

Define invariantes de confiabilidad, normalización de configuración y validación de parámetros en el cliente Odoo y herramientas existentes.

## Requirements

### Requirement: REQ-CLIENT-001 — Normalización de URL base de Odoo
`createOdooClient` MUST eliminar barras diagonales finales (`/`) de la URL configurada por `ODOO_URL`, de `session.json` y de `authenticate({ url })` antes de construir `<url>/jsonrpc`.

#### Scenario: SCN-CLIENT-001 — URL con barras finales no genera doble barra
- **WHEN** `ODOO_URL` o `session.json` contienen una URL terminada en `/` o `///`
- **THEN** las llamadas JSON-RPC apuntan exactamente a `<url_sin_slash>/jsonrpc` y `getSession().url` queda normalizada

---

### Requirement: REQ-TIMESHEET-001 — Total de horas global en listados paginados
`odoo_get_my_timesheets` MUST consultar `read_group` (`unit_amount:sum`) con el mismo dominio que `search_count` y `search_read` para reportar `total_hours` sobre todo el rango filtrado cuando el servidor devuelva un agregado numérico, manteniendo la suma de página como respaldo cuando no exista agregado.

#### Scenario: SCN-TIMESHEET-001 — Paginación con agregado global
- **WHEN** `search_read` devuelve una página parcial y `read_group` retorna `unit_amount: 27.5`
- **THEN** `structuredContent.total_hours` y el resumen de texto reflejan `27.5`

---

### Requirement: REQ-GITLAB-001 — Aislamiento de variables de entorno en inspección GitLab
`remoteFromLink` y `inspectGitLabBranch` MUST aceptar un objeto `env` opcional para resolver `ODOO_GITLAB_ALLOWED_HOSTS` y `ODOO_GIT_TIMEOUT_MS` sin acoplarse exclusivamente a `process.env`.

#### Scenario: SCN-GITLAB-001 — Host personalizado vía env inyectado
- **WHEN** se invoca `remoteFromLink` pasando `{ ODOO_GITLAB_ALLOWED_HOSTS: "git.custom.example" }`
- **THEN** acepta el host personalizado sin mutar `process.env`

---

### Requirement: REQ-TICKET-001 — Validación estricta de attachment_id en frames de video
`odoo_get_ticket_video_frames` MUST validar `attachment_id` mediante `positiveInt` cuando se provea dicho parámetro.

#### Scenario: SCN-TICKET-001 — Rechazo de attachment_id inválido
- **WHEN** se pasa `attachment_id: 0` o `"abc"`
- **THEN** lanza un error de validación indicando que `attachment_id` debe ser un entero positivo
