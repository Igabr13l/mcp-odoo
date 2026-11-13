# knowledge-articles

## Purpose

Proporciona herramientas MCP para listar, leer, crear, editar, restaurar y enviar a la Papelera artículos de documentación en Odoo Knowledge (`knowledge.article`) respetando permisos de acceso, bloqueo de contenido y protección de secretos.

## Requirements

### Requirement: REQ-KNOWLEDGE-001 — Listado y búsqueda segura de artículos
El servidor MUST exponer `odoo_get_knowledge_articles` para consultar artículos en `knowledge.article` aplicando por defecto `user_has_access = true`, `is_template = false` y `active = true`, con soporte opcional para `search`, `category` (`workspace | private | shared`), `parent_id`, `roots_only`, `include_trashed`, `include_items`, `items_only`, `favorites_only`, `stage_id`, `limit` (default 50, máx 200) y `offset` (default 0).

Cuando `include_trashed` sea `true`, el sistema MUST omitir el filtro `active = true` y enviar `context: { active_test: false }` en `search_count` y `search_read`.

#### Scenario: SCN-KNOWLEDGE-001 — Búsqueda filtrada de artículos accesibles
- **WHEN** se invoca `odoo_get_knowledge_articles` con `search`, `category`, `parent_id`, `favorites_only`, `stage_id` o `include_items: false`
- **THEN** el dominio incluye `is_template = false`, `user_has_access = true`, `active = true`, los filtros correspondientes, y devuelve `articles`, `total_count`, `offset` y `has_more`

#### Scenario: SCN-KNOWLEDGE-002 — Inclusión de papelera y raíces
- **WHEN** se invoca `odoo_get_knowledge_articles` con `include_trashed: true` y `roots_only: true`
- **THEN** se envía `context: { active_test: false }` y `["parent_id", "=", false]` en el dominio

#### Scenario: SCN-KNOWLEDGE-003 — Rechazo de categoría u offset inválidos
- **WHEN** se pasa una `category` fuera de `workspace | private | shared` o un `offset` negativo/no entero
- **THEN** la herramienta falla con un error descriptivo de validación

---

### Requirement: REQ-KNOWLEDGE-002 — Lectura de artículo individual y redacción de secretos
El servidor MUST exponer `odoo_get_knowledge_article` (`article_id` requerido) leyendo el registro con `context: { active_test: false }`.

Si el artículo no existe, MUST responder `found: false`. Si `user_has_access === false`, MUST rechazar la lectura con error de acceso denegado. El contenido HTML (`body_html`) y texto (`body_text`) MUST redactar secretos por defecto (`redact_secrets !== false`), incluir estado de favorito, publicación web, etapa Kanban y propiedades, y consultar hijos inmediatos accesibles salvo que `include_children === false`.

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

### Requirement: REQ-KNOWLEDGE-003 — Creación de artículos raíz, hijos e ítems Kanban
El servidor MUST exponer `odoo_create_knowledge_article` (`name` no vacío requerido).

- Si `body` no contiene etiquetas de bloque HTML, MUST convertir párrafos de texto plano a `<p>...</p>` escapando entidades HTML; si contiene HTML, MUST preservarlo.
- Para artículos raíz sin `parent_id`: `category: "workspace"` (default) MUST usar `internal_permission: "write"`; `category: "private"` MUST usar `internal_permission: "none"` y agregar al `partner_id` del usuario actual en `article_member_ids` con permiso `"write"`.
- Si se especifica `parent_id`, MUST validar que el padre exista, no esté en Papelera y tenga `user_has_write_access !== false`, y MUST rechazar `category: "private"`.
- Si `is_article_item: true`, MUST exigir `parent_id`; soporta `stage_id`, `article_properties`, `is_published` e `is_favorite`.

#### Scenario: SCN-KNOWLEDGE-007 — Creación de artículo workspace, privado e hijo
- **WHEN** se crea un artículo raíz `workspace`, uno `private` y uno hijo/ítem con `parent_id`
- **THEN** el workspace usa `internal_permission: "write"`, el privado usa `internal_permission: "none"` con `article_member_ids` del usuario actual, el hijo hereda permisos, y si `is_favorite: true` invoca `action_toggle_favorite`

#### Scenario: SCN-KNOWLEDGE-008 — Validaciones de creación y verificación tolerante
- **WHEN** `name` está vacío, `is_article_item: true` carece de `parent_id`, el padre no tiene acceso de escritura o está en Papelera, o la lectura de verificación posterior falla
- **THEN** rechaza la creación antes de escribir ante entradas/padres inválidos, y si falla solo la verificación posterior devuelve `created: true` con `verified: false`

---

### Requirement: REQ-KNOWLEDGE-004 — Edición incremental, favoritos, publicación, propiedades y restauración
El servidor MUST exponer `odoo_update_knowledge_article` (`article_id` requerido).

MUST verificar existencia (`active_test: false`) y `user_has_write_access !== false`. Para editar el cuerpo, MUST permitir exactamente un modo por llamada: reemplazo total (`body`), `append_body`, `prepend_body` o `replace_text` (`{ find, replace, replace_all? }`). Si el artículo está bloqueado (`is_locked === true`) y se intenta editar contenido sin `is_locked: false`, MUST rechazar la edición. Si `is_favorite` difiere de `is_user_favorite`, MUST invocar `action_toggle_favorite`. Si `is_published` se modifica sin `can_publish`, MUST rechazar la publicación. Soporta `is_article_item`, `stage_id`, `article_properties` y `restore: true` (`action_unarchive`).

#### Scenario: SCN-KNOWLEDGE-009 — Protección de artículo bloqueado y desbloqueo explícito
- **WHEN** se intenta editar el cuerpo de un artículo con `is_locked: true`
- **THEN** falla indicando que está bloqueado, salvo que también se envíe `is_locked: false`, caso en que escribe el desbloqueo primero y luego el contenido

#### Scenario: SCN-KNOWLEDGE-010 — Edición incremental, favoritos, publicación y restauración
- **WHEN** se usa `append_body`, `prepend_body`, `replace_text`, `is_favorite`, `is_published`, `stage_id`/`article_properties` o `restore: true`
- **THEN** aplica solo una modalidad de cuerpo por llamada, rechaza `replace_text` ausente o ambiguo sin `replace_all: true`, alterna favorito solo cuando cambia, valida `can_publish` y restaura vía `action_unarchive`

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

---

### Requirement: REQ-KNOWLEDGE-006 — Etapas Kanban y definición de propiedades de ítems
El servidor MUST exponer `odoo_get_knowledge_stages` (`parent_id` requerido) para listar las etapas en `knowledge.article.stage` y `article_properties_definition` del artículo padre tras validar acceso de lectura.

#### Scenario: SCN-KNOWLEDGE-013 — Consulta de etapas y esquema de propiedades
- **WHEN** se invoca `odoo_get_knowledge_stages` sobre un artículo padre accesible
- **THEN** devuelve sus etapas ordenadas por `sequence, id` junto con `properties_definition`

---

### Requirement: REQ-KNOWLEDGE-007 — Adjuntos e imágenes de Knowledge
El servidor MUST exponer `odoo_get_knowledge_article_attachments`, `odoo_get_knowledge_article_images` y `odoo_add_knowledge_attachment`.

Las lecturas MUST verificar acceso al artículo, excluir binarios `datas` en metadatos y redactar secretos en `name`, `description` y `url`. `odoo_get_knowledge_article_images` MUST devolver bloques nativos `type: "image"` respetando `limit` y `max_bytes`. `odoo_add_knowledge_attachment` MUST validar permiso de escritura, que el artículo no esté bloqueado y exigir exactamente uno de `data_base64` o `url`.

#### Scenario: SCN-KNOWLEDGE-014 — Lectura de adjuntos/imágenes y carga de adjunto
- **WHEN** se listan adjuntos, se leen imágenes o se agrega un adjunto binario/URL sobre un artículo editable no bloqueado
- **THEN** las lecturas omiten `datas` en metadatos y devuelven imágenes válidas como bloques MCP, y el alta crea `ir.attachment` con `res_model: "knowledge.article"`

---

### Requirement: REQ-KNOWLEDGE-008 — Comentarios e hilos anclados de Knowledge
El servidor MUST exponer `odoo_get_knowledge_article_comments` y `odoo_add_knowledge_comment`.

`odoo_get_knowledge_article_comments` MUST reunir hilos anclados (`knowledge.article.thread`) y mensajes del chatter (`mail.message`) redactando secretos por defecto. `odoo_add_knowledge_comment` MUST previsualizar sin `confirm: true` y, con `confirm: true`, publicar comentarios en artículo o hilo, crear hilos nuevos con `anchor_text`, o actualizar `is_resolved` cuando se indique `resolve` en un `thread_id` perteneciente al artículo.

#### Scenario: SCN-KNOWLEDGE-015 — Lectura de hilos/chatter y publicación con preview/confirm
- **WHEN** se consultan comentarios y luego se agrega un comentario anclado o se resuelve un hilo con `confirm: false` y después `confirm: true`
- **THEN** la lectura combina hilos y chatter redactados, `confirm: false` devuelve `status: "preview"` sin mutar y `confirm: true` publica el comentario y actualiza `is_resolved` si corresponde
