# knowledge-articles

## Purpose

Proporciona herramientas MCP para listar, leer, crear, editar, restaurar y enviar a la Papelera artículos de documentación en Odoo Knowledge (`knowledge.article`) respetando permisos de acceso, bloqueo de contenido y protección de secretos.

## Requirements

### Requirement: REQ-KNOWLEDGE-001 — Listado y búsqueda segura de artículos
El servidor MUST exponer `odoo_get_knowledge_articles` para consultar artículos en `knowledge.article` aplicando por defecto `user_has_access = true`, `is_template = false` y `active = true`, con soporte opcional para `search`, `category` (`workspace | private | shared`), `parent_id`, `roots_only`, `include_trashed`, `include_items`, `limit` (default 50, máx 200) y `offset` (default 0).

Cuando `include_trashed` sea `true`, el sistema MUST omitir el filtro `active = true` y enviar `context: { active_test: false }` en `search_count` y `search_read`.

#### Scenario: SCN-KNOWLEDGE-001 — Búsqueda filtrada de artículos accesibles
- **WHEN** se invoca `odoo_get_knowledge_articles` con `search`, `category`, `parent_id` e `include_items: false`
- **THEN** el dominio incluye `is_template = false`, `user_has_access = true`, `active = true`, `is_article_item = false`, `category`, `parent_id` y `name ilike`, devolviendo `articles`, `total_count`, `offset` y `has_more`

#### Scenario: SCN-KNOWLEDGE-002 — Inclusión de papelera y raíces
- **WHEN** se invoca `odoo_get_knowledge_articles` con `include_trashed: true` y `roots_only: true`
- **THEN** se envía `context: { active_test: false }` y `["parent_id", "=", false]` en el dominio

#### Scenario: SCN-KNOWLEDGE-003 — Rechazo de categoría u offset inválidos
- **WHEN** se pasa una `category` fuera de `workspace | private | shared` o un `offset` negativo/no entero
- **THEN** la herramienta falla con un error descriptivo de validación

---

### Requirement: REQ-KNOWLEDGE-002 — Lectura de artículo individual y redacción de secretos
El servidor MUST exponer `odoo_get_knowledge_article` (`article_id` requerido) leyendo el registro con `context: { active_test: false }`.

Si el artículo no existe, MUST responder `found: false`. Si `user_has_access === false`, MUST rechazar la lectura con error de acceso denegado. El contenido HTML (`body_html`) y texto (`body_text`) MUST redactar secretos por defecto (`redact_secrets !== false`), y MUST consultar hijos inmediatos accesibles salvo que `include_children === false`.

#### Scenario: SCN-KNOWLEDGE-004 — Lectura completa con hijos y secretos enmascarados
- **WHEN** se consulta un artículo existente con `child_ids` y credenciales en el cuerpo HTML
- **THEN** devuelve texto legible e HTML con secretos reemplazados por `[REDACTED]` y la lista `children` accesible

#### Scenario: SCN-KNOWLEDGE-005 — Artículo inexistente o sin acceso
- **WHEN** el artículo no existe o tiene `user_has_access: false`
- **THEN** devuelve `found: false` si no existe, o lanza error de acceso denegado si `user_has_access === false`

#### Scenario: SCN-KNOWLEDGE-006 — Lectura sin redacción ni hijos
- **WHEN** se invoca con `redact_secrets: false` e `include_children: false`
- **THEN** preserva el contenido sin enmascarar y omite la consulta adicional de hijos

---

### Requirement: REQ-KNOWLEDGE-003 — Creación de artículos raíz e hijos
El servidor MUST exponer `odoo_create_knowledge_article` (`name` no vacío requerido).

- Si `body` no contiene etiquetas de bloque HTML, MUST convertir párrafos de texto plano a `<p>...</p>` escapando entidades HTML; si contiene HTML, MUST preservarlo.
- Para artículos raíz sin `parent_id`: `category: "workspace"` (default) MUST usar `internal_permission: "write"`; `category: "private"` MUST usar `internal_permission: "none"` y agregar al `partner_id` del usuario actual en `article_member_ids` con permiso `"write"`.
- Si se especifica `parent_id`, MUST validar que el padre exista, no esté en Papelera y tenga `user_has_write_access !== false`, y MUST rechazar `category: "private"`.

#### Scenario: SCN-KNOWLEDGE-007 — Creación de artículo workspace, privado e hijo
- **WHEN** se crea un artículo raíz `workspace`, uno `private` y uno hijo con `parent_id`
- **THEN** el workspace usa `internal_permission: "write"`, el privado usa `internal_permission: "none"` con `article_member_ids` del usuario actual, y el hijo hereda permisos sin forzar `internal_permission`

#### Scenario: SCN-KNOWLEDGE-008 — Validaciones de creación y verificación tolerante
- **WHEN** `name` está vacío, el padre no tiene acceso de escritura o está en Papelera, o la lectura de verificación posterior falla
- **THEN** rechaza la creación antes de escribir ante entradas/padres inválidos, y si falla solo la verificación posterior devuelve `created: true` con `verified: false`

---

### Requirement: REQ-KNOWLEDGE-004 — Edición, bloqueo y restauración
El servidor MUST exponer `odoo_update_knowledge_article` (`article_id` requerido).

MUST verificar existencia (`active_test: false`) y `user_has_write_access !== false`. Si el artículo está bloqueado (`is_locked === true`) y se intenta editar `name`, `body` o `icon` sin pasar `is_locked: false`, MUST rechazar la edición. Si se pasa `is_locked: false` junto con cambios de contenido, MUST desbloquear primero antes de escribir el resto. Si `restore === true` sobre un artículo en Papelera, MUST invocar `action_unarchive`.

#### Scenario: SCN-KNOWLEDGE-009 — Protección de artículo bloqueado y desbloqueo explícito
- **WHEN** se intenta editar el cuerpo de un artículo con `is_locked: true`
- **THEN** falla indicando que está bloqueado, salvo que también se envíe `is_locked: false`, caso en que escribe el desbloqueo primero y luego el contenido

#### Scenario: SCN-KNOWLEDGE-010 — Restauración y validación de nuevo padre
- **WHEN** se invoca con `restore: true` sobre un artículo archivado, o con `parent_id` igual al propio artículo / inexistente / en Papelera
- **THEN** ejecuta `action_unarchive` en el primer caso y rechaza relaciones padre inválidas antes de escribir

---

### Requirement: REQ-KNOWLEDGE-005 — Envío seguro a Papelera
El servidor MUST exponer `odoo_delete_knowledge_article` (`article_id` y `confirm` requeridos).

MUST rechazar si el artículo no existe, si no hay permiso de escritura o si `is_locked === true`. Si ya está en Papelera (`active === false || to_delete === true`), MUST responder de forma idempotente `status: "already_trashed"`. Si `confirm !== true`, MUST devolver `status: "preview"` con `child_count` sin ejecutar `action_send_to_trash`. Con `confirm === true`, MUST invocar `action_send_to_trash` y verificar `deletion_date`.

#### Scenario: SCN-KNOWLEDGE-011 — Preview, envío confirmado e idempotencia
- **WHEN** se invoca con `confirm: false` y luego con `confirm: true` dos veces seguidas
- **THEN** la primera llamada devuelve `status: "preview"` sin mutar, la segunda invoca `action_send_to_trash` devolviendo `status: "trashed"`, y la tercera responde `status: "already_trashed"`

#### Scenario: SCN-KNOWLEDGE-012 — Bloqueo impide envío a Papelera
- **WHEN** se intenta enviar a Papelera un artículo con `is_locked: true` o sin acceso de escritura
- **THEN** la operación falla antes de invocar `action_send_to_trash`
