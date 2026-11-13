# Propuesta: Odoo Knowledge y Hardening de MCP Odoo

## Resumen
Agregar soporte completo CRUD/Papelera para documentación de Odoo Knowledge (`/odoo/knowledge`, modelo `knowledge.article`) en el MCP autoritativo `mcp-odoo`, junto con correcciones de confiabilidad detectadas durante la revisión técnica del repositorio.

## Motivación
- Permitir crear, consultar, editar, restaurar y enviar a la Papelera artículos de documentación directamente desde OpenCode sin abrir el navegador.
- Cerrar hallazgos menores de revisión (normalización de URL, totalización paginada de horas, aislamiento de `env`, validación de `attachment_id` y documentación del README).

## Alcance
- `src/tools/knowledge.ts` + registro en `src/index.ts`.
- Correcciones en `src/odoo/client.ts`, `src/tools/timesheets.ts`, `src/tools/gitlab-status.ts`, `src/tools/ticket-content.ts` y `README.md`.
- Permisos en `/Users/igabr13l/_repo/hubeet/opencode.json`.
- Tests unitarios determinísticos en `test/`.

## Non-goals
- No modifica `hubeet-mcps/packages/mcp-odoo` (integración HTTP separada).
- No implementa edición de propiedades dinámicas (`article_properties`) ni gestión granular de `knowledge.article.member` más allá del creador en artículos privados.
