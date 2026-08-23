# MCP Odoo - Model Context Protocol para Odoo

MCP server que permite interacturar con Odoo desde cualquier IDE compatible con MCP (OpenCode, Cursor, Claude Desktop, etc.)

## Características

- 🔐 **Login con credenciales propias** - Cada usuario usa sus credenciales de Odoo
- **Gestión de tareas** - Lista tus tareas, filtra por proyecto y estado
- **Contexto de tickets** - Reúne descripción, chatter, evidencia, ramas, etapas y horas
- **Timesheets seguros** - Valida tarea, proyecto, duplicados y propiedad de líneas
- **Ramas GitLab** - Verifica referencias y divergencia antes de crear un MR
- 🔄 **Genérico** - Funciona con cualquier instancia de Odoo 17+

## Instalación

```bash
git clone https://github.com/Igabr13l/mcp-odoo.git
cd mcp-odoo
npm install
```

## Configuración por IDE

### OpenCode

Agregar en `opencode.json` de tu workspace:

```json
{
  "mcp": {
    "odoo": {
      "type": "local",
      "command": ["node", "/ruta/absoluta/a/mcp-odoo/src/index.js"],
      "enabled": true
    }
  }
}
```

### Cursor / Claude Desktop

Agregar en `cursor.json` o `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "odoo": {
      "command": "node",
      "args": ["/ruta/absoluta/a/mcp-odoo/src/index.js"]
    }
  }
}
```

### VS Code (con extension MCP)

En settings.json:

```json
{
  "mcpServers": {
    "odoo": {
      "command": "node",
      "args": ["C:\\ruta\\a\\mcp-odoo\\src\\index.js"]
    }
  }
}
```

### Windsurf

En `~/.windsurf/config.json` o en el archivo de configuración del proyecto:

```json
{
  "mcp": {
    "odoo": {
      "type": "local",
      "command": ["node", "/ruta/a/mcp-odoo/src/index.js"]
    }
  }
}
```

## Uso

### 1. Login (obligatorio)

Primero, iniciá sesión con tus credenciales de Odoo:

```
odoo_login({
  url: "https://odoo.tuempresa.com",
  db: "nombre_db",
  login: "tu@email.com",
  password: "tu_password"
})
```

### 2. Herramientas disponibles

| Herramienta | Descripción |
|-------------|-------------|
| `odoo_whoami` | Muestra el usuario actual conectado |
| `odoo_get_projects` | Lista todos los proyectos activos |
| `odoo_get_my_projects` | Lista los proyectos donde tenés tickets asignados |
| `odoo_get_my_tasks` | Lista tus tareas (opcional: project_id, state) |
| `odoo_get_tickets` | Lista tickets con filtros (mine, project_id, state, search, limit), prioridad y etiquetas |
| `odoo_get_task_detail` | Detalle de una tarea con asignados, etiquetas, prioridad, descripcion y metricas |
| `odoo_get_ticket_messages` | Lee mensajes y notas internas del chatter; oculta secretos por defecto |
| `odoo_get_ticket_attachments` | Lista adjuntos, imágenes y videos con sus metadatos |
| `odoo_get_ticket_images` | Devuelve imágenes adjuntas como contenido visual MCP |
| `odoo_get_ticket_video_frames` | Extrae fotogramas representativos de videos adjuntos |
| `odoo_get_ticket_context` | Devuelve contexto agregado del ticket en una llamada |
| `odoo_get_project_stages` | Lista IDs y nombres exactos de todas las etapas del proyecto |
| `odoo_add_ticket_note` | Previsualiza o publica una nota interna redactada con confirmación |
| `odoo_get_my_board` | Tablero personal agrupado por etapas reales de Odoo |
| `odoo_get_gitlab_status` | Verifica ramas y referencias de MR directamente en GitLab |
| `odoo_update_task` | Edita asignados, descripción y estado/etapa de una tarea |
| `odoo_get_task_gitlab_branches` | Ramas GitLab vinculadas a una tarea |
| `odoo_create_timesheet` | Carga horas en una tarea |
| `odoo_get_my_timesheets` | Lista tus horas cargadas con filtros por fecha/proyecto/tarea |

### 3. Ejemplos de uso

#### Ver mis tareas en progreso
```
odoo_get_my_tasks({ state: "in_progress" })
```

#### Ver tareas de un proyecto específico
```
odoo_get_my_tasks({ project_id: 7, state: "in_progress" })
```

#### Ver mis proyectos (donde tengo tickets)
```
odoo_get_my_projects({})
```

#### Ver tickets con filtros
```
odoo_get_tickets({ mine: true, state: "to_do", search: "whatsapp", limit: 50 })
```

#### Ver detalle de una tarea con ramas GitLab
```
odoo_get_task_detail({ task_id: 9646 })
```

#### Leer mensajes, notas y adjuntos
```
odoo_get_ticket_messages({ task_id: 9646, include_system: false })
odoo_get_ticket_attachments({ task_id: 9646 })
odoo_get_ticket_images({ task_id: 9646, limit: 5 })
odoo_get_ticket_video_frames({ task_id: 9646, frames: 4 })
```

Los videos se listan con nombre, tipo MIME, tamaño y URL cuando Odoo guarda una.
MCP no define contenido de video nativo, por lo que el servidor no carga el binario
del video en el contexto. API keys, tokens y passwords se enmascaran por defecto en
descripciones y mensajes.

La extracción de fotogramas requiere `ffmpeg` y `ffprobe` instalados localmente.

#### Ver tablero y estado GitLab
```
odoo_get_my_board({ project_id: 7 })
odoo_get_gitlab_status({ task_id: 11244 })
```

La creación de una fila GitLab, una rama o un merge request requiere
`confirm: true`. Las operaciones son idempotentes cuando Odoo ya tiene el
recurso registrado. Antes de crear un MR, el MCP obtiene la divergencia real y
compara los árboles resultantes; rechaza ramas sin commits propios o cuyo árbol
es idéntico al merge base. El MCP no fusiona MRs.

#### Editar una tarea (asignados, descripción y estado)
```
odoo_update_task({
  task_id: 9646,
  assignee_user_ids: [16],
  description: "Actualizar validaciones de WhatsApp",
  state: "in_progress"
})
```

También podés usar `stage_id` o `stage_name` en vez de `state`.

#### Ver ramas GitLab de una tarea
```
odoo_get_task_gitlab_branches({ task_id: 9646 })
```

#### Cargar horas
```
odoo_create_timesheet({
  task_id: 9646,
  project_id: 7,
  date: "2026-03-01",
  hours: 2,
  description: "Implementación de feature X"
})
```

Las altas y modificaciones de timesheets se serializan dentro de cada proceso
MCP para que la verificación de duplicados y la escritura formen una única
sección crítica. Esto no coordina procesos MCP distintos ni otros clientes de
Odoo: la idempotencia entre procesos y a nivel servidor sigue siendo
responsabilidad de Odoo.

#### Ver horas cargadas un día específico
```
odoo_get_my_timesheets({ date: "2026-02-27" })
```

#### Ver horas cargadas en un rango de fechas
```
odoo_get_my_timesheets({ date_from: "2026-02-01", date_to: "2026-02-28" })
```

#### Ver horas de un proyecto específico
```
odoo_get_my_timesheets({ project_id: 7, date_from: "2026-02-01", date_to: "2026-02-28" })
```

## Configuración de Variables de Entorno

Podés configurar valores por defecto:

```bash
export ODOO_URL="https://odoo.tuempresa.com"
export ODOO_DB="nombre_db"
```

Pero seguís necesitando hacer login con tu usuario y password.

La sesión es única por proceso y se reutiliza durante toda la ejecución. El MCP
no reautentica periódicamente: Odoo valida las credenciales en cada operación
`execute_kw`. Si varias herramientas arrancan al mismo tiempo sin un `uid`
persistido, comparten un único intento de autenticación.

El timeout HTTP por defecto es de 15 segundos. Puede configurarse entre 1 y 120
segundos con `ODOO_REQUEST_TIMEOUT_MS`.

Las lecturas con errores transitorios de red o timeout se reintentan una sola
vez. Las escrituras nunca se reintentan automáticamente: si el transporte falla,
el resultado se marca como incierto y requiere verificar Odoo antes de repetir.
El backoff de lectura se configura con `ODOO_RETRY_BACKOFF_MS`.

La sesión persistida se guarda con permisos `0600` y contiene las credenciales
necesarias para JSON-RPC. Puede cambiarse su ubicación con `ODOO_SESSION_FILE`.

La verificación remota de GitLab permite `gitlab.solunika.com` por defecto. Para
otras instalaciones, configurá una lista separada por comas en
`ODOO_GITLAB_ALLOWED_HOSTS`.

Si `ODOO_GITLAB_TOKEN` está configurado, `odoo_get_gitlab_status` consulta la API
v4 de GitLab con `PRIVATE-TOKEN` para informar estado, conflictos, pipelines y
aprobaciones del merge request. Las redirecciones no se siguen para evitar enviar
el token a otro origen, y el token nunca se incluye en la respuesta. El timeout
de estas consultas es de 15 segundos y puede configurarse entre 1 y 120 segundos
mediante `ODOO_GITLAB_API_TIMEOUT_MS`.

La inspección Git informa divergencia, merge base, hashes de árbol y si el árbol
de la rama difiere del merge base. Una rama solo se considera activa si tiene
commits propios y un árbol resultante diferente. Cada comando usa un timeout de
15 segundos, configurable mediante `ODOO_GIT_TIMEOUT_MS`.

## Licencia

MIT
