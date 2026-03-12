# MCP Odoo - Model Context Protocol para Odoo

MCP server que permite interacturar con Odoo desde cualquier IDE compatible con MCP (OpenCode, Cursor, Claude Desktop, etc.)

## Características

- 🔐 **Login con credenciales propias** - Cada usuario usa sus credenciales de Odoo
- 📋 **Gestión de tareas** - Lista tus tareas, filtra por proyecto y estado
- 🧾 **Detalle enriquecido** - Ve etiquetas, prioridad legible y descripcion de cada ticket
- ⏱️ **Timesheets** - Carga horas trabajadas
- 🔀 **Ramas GitLab** - Ver ramas asociadas a cada tarea
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

## Licencia

MIT
