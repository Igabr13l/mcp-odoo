# MCP Odoo - Model Context Protocol para Odoo

MCP server que permite interacturar con Odoo desde cualquier IDE compatible con MCP (OpenCode, Cursor, Claude Desktop, etc.)

## Características

- 🔐 **Login con credenciales propias** - Cada usuario usa sus credenciales de Odoo
- 📋 **Gestión de tareas** - Lista tus tareas, filtra por proyecto y estado
- ⏱️ **Timesheets** - Carga horas trabajadas
- � ramas GitLab** - Ver ramas asociadas a cada tarea
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
| `odoo_get_my_tasks` | Lista tus tareas (opcional: project_id, state) |
| `odoo_get_task_detail` | Detalle de una tarea específica |
| `odoo_get_task_gitlab_branches` | Ramas GitLab vinculadas a una tarea |
| `odoo_create_timesheet` | Carga horas en una tarea |

### 3. Ejemplos de uso

#### Ver mis tareas en progreso
```
odoo_get_my_tasks({ state: "in_progress" })
```

#### Ver tareas de un proyecto específico
```
odoo_get_my_tasks({ project_id: 7, state: "in_progress" })
```

#### Ver detalle de una tarea con ramas GitLab
```
odoo_get_task_detail({ task_id: 9646 })
```

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

## Configuración de Variables de Entorno

Podés configurar valores por defecto:

```bash
export ODOO_URL="https://odoo.tuempresa.com"
export ODOO_DB="nombre_db"
```

Pero seguís necesitando hacer login con tu usuario y password.

## Licencia

MIT
