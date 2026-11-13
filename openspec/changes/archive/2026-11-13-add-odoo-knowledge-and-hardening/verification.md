# Matriz de Trazabilidad y Verificación

| ID | Cobertura en Tests | Comando de Verificación |
|----|--------------------|-------------------------|
| `REQ-KNOWLEDGE-001` (`SCN-KNOWLEDGE-001..003`) | `test/knowledge.test.ts` (`odoo_get_knowledge_articles`) | `npm test` |
| `REQ-KNOWLEDGE-002` (`SCN-KNOWLEDGE-004..006`) | `test/knowledge.test.ts` (`odoo_get_knowledge_article`) | `npm test` |
| `REQ-KNOWLEDGE-003` (`SCN-KNOWLEDGE-007..008`) | `test/knowledge.test.ts` (`odoo_create_knowledge_article`, `normalizeArticleBody`) | `npm test` |
| `REQ-KNOWLEDGE-004` (`SCN-KNOWLEDGE-009..010`) | `test/knowledge.test.ts` (`odoo_update_knowledge_article`) | `npm test` |
| `REQ-KNOWLEDGE-005` (`SCN-KNOWLEDGE-011..012`) | `test/knowledge.test.ts` (`odoo_delete_knowledge_article`) | `npm test` |
| `REQ-CLIENT-001` (`SCN-CLIENT-001`) | `test/client.test.ts` (`normalizes trailing slashes...`) | `npm test` |
| `REQ-TIMESHEET-001` (`SCN-TIMESHEET-001`) | `test/timesheets.test.ts` (`uses read_group total_hours...`) | `npm test` |
| `REQ-GITLAB-001` (`SCN-GITLAB-001`) | `test/gitlab-status.test.ts` (`remoteFromLink accepts configured GitLab hosts`) | `npm test` |
| `REQ-TICKET-001` (`SCN-TICKET-001`) | `test/ticket-content.test.ts` (`validates attachment_id...`) | `npm test` |
