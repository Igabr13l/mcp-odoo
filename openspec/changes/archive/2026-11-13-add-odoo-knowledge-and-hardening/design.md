# Diseño: Odoo Knowledge y Hardening

## Modelo Odoo (`knowledge.article`)
Verificado contra `https://odoo.solunika.com`:
- Permisos del usuario estándar: `read: true`, `write: true`, `create: true`, `unlink: false`.
- Borrado lógico / Papelera: `action_send_to_trash` marca `active: false`, `to_delete: true` y calcula `deletion_date`.
- Restauración: `action_unarchive` restaura el artículo.
- Visibilidad: `user_has_access` distingue artículos accesibles de artículos privados de otros usuarios.
- Escritura: `user_has_write_access` e `is_locked` determinan si el contenido puede editarse.

## Herramientas nuevas
1. `odoo_get_knowledge_articles`
2. `odoo_get_knowledge_article`
3. `odoo_create_knowledge_article`
4. `odoo_update_knowledge_article`
5. `odoo_delete_knowledge_article`

## Decisiones de seguridad y compatibilidad
- `action_send_to_trash` y `action_unarchive` no están en `READ_ONLY_METHODS` de `src/odoo/client.ts`, por lo que nunca se reintentan automáticamente ante fallos de transporte.
- `odoo_get_my_timesheets` agrega `read_group` manteniendo respaldo a `pageHours` para conservar compatibilidad con mocks que no simulan `read_group`.
