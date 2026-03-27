# AgentGuard — Estado Actual y Próximos Pasos
**Fecha:** 27 de marzo 2026

---

## ¿Qué hace AgentGuard hoy?

AgentGuard es un wrapper de terminal que se coloca entre el developer y cualquier agente de IA (Claude Code, Codex, aider). Su función es monitorear lo que el agente hace mientras trabaja.

Tiene dos capas de defensa activas:

**Capa 1 — PTY Interceptor (comandos shell)**
Monitorea la terminal en tiempo real. Si el agente intenta correr comandos destructivos (`rm -rf`, `git reset --hard`, `git push --force`, etc.), AgentGuard los clasifica por nivel de riesgo y puede pedir aprobación antes de ejecutarlos.

**Capa 2 — File Watcher (ediciones de archivos)**
Monitorea el sistema de archivos en paralelo. Detecta cualquier archivo que el agente modifique — incluso si el agente no usa comandos shell (como hace Claude Code en modo `--print`). Si el archivo es sensible (`.env`, llaves privadas, configs de CI/CD), alerta al developer.

**Sistema de snapshots**
Al inicio de cada sesión, AgentGuard hace un `git stash` automático del estado actual del repo. Si algo sale mal, el developer puede revertir con un comando.

**Audit log**
Cada sesión queda registrada en `~/.agentguard/audit.log` — qué comandos se corrieron, qué archivos se tocaron, qué se aprobó y qué se bloqueó.

---

## Qué se probó hoy (27/3)

### ✅ Lo que funcionó
- Instalación global via `npm install -g .`
- Snapshot automático al detectar cambios en el repo
- Watcher detectó edición de `index.js` en tiempo real mientras Claude trabajaba
- Watcher detectó edición de `.env` y lanzó el prompt de aprobación (HIGH RISK)
- Summary de sesión con conteo de comandos, ediciones, y estado del snapshot
- Corrección del bug: summary ya no muestra "not a git repo" cuando el árbol está limpio

### ⚠️ Lo que reveló la prueba
- En modo `--print`, Claude escribe archivos y termina en milisegundos — el watcher detecta pero no puede pausar el agente a tiempo. El rollback via snapshot es la solución correcta para este caso.
- El interceptor PTY no captura nada en modo `--print` — solo el watcher funciona ahí.

---

## Decisión de Diseño Clave

> **AgentGuard no debe bloquear lo que el developer pide explícitamente.**
> Su valor está en detectar efectos secundarios no pedidos.

| Escenario | ¿AgentGuard interviene? |
|---|---|
| "Modifica mi .env" → Claude modifica .env | ❌ Era la intención |
| "Refactoriza auth.js" → Claude toca .env de paso | ✅ Efecto secundario |
| "Limpia el código" → Claude hace `rm -rf utils/` | ✅ Destructivo no pedido |
| "Borra los tests viejos" → Claude borra tests | ❌ Era la intención |

Esto implica que AgentGuard necesita **contexto de intención** — saber qué le pidió el developer al agente para distinguir acciones esperadas de efectos colaterales. Es el diferenciador más importante del producto y ninguna herramienta del mercado lo hace hoy.

---

## Lo que falta

### Técnico
- [ ] **Rollback automático en deny** — cuando el watcher detecta un cambio sensitivo y el usuario niega, AgentGuard debe restaurar el snapshot automáticamente. El snapshot ya existe, falta conectar el deny con el restore.
- [ ] **Contexto de intención** — pasar el prompt original del developer a AgentGuard para que pueda comparar la acción del agente con la intención declarada. Si Claude toca algo fuera del scope, alerta.
- [ ] **Diff preview** — antes de aprobar o denegar, mostrar exactamente qué cambió en el archivo (como `git diff`). Ahora solo muestra el nombre del archivo.
- [ ] **Modo solo auditoría** — correr sin interrumpir, solo registrar. Útil para developers que quieren aprender qué hace el agente sin bloquear nada.
- [ ] **Config por proyecto** — `agentguard.config.json` que define qué archivos proteger, qué nivel de riesgo auto-aprobar, qué directorios son off-limits.
- [ ] **Soporte para más agentes** — probado con Claude Code. Falta probar con Codex CLI (`@openai/codex`), aider, Continue.
- [ ] **Tests automatizados** — suite de "comandos maliciosos" que verifica que AgentGuard los atrapa al 100%.

### Producto / UX
- [ ] **Instrucciones de instalación claras** — `npm install -g agentguard` + setup en 2 minutos
- [ ] **GIF / video demo** — mostrar el momento en que AgentGuard intercepta un `.env` touch. Sin esto no hay nada que mostrar en GitHub ni Product Hunt.
- [ ] **README mejorado** — con ejemplos reales, casos de uso, y el "por qué importa"

### Outreach / Validación
- [ ] **Publicar repo en GitHub** — sin anunciar, solo tenerlo disponible
- [ ] **5 beta testers** — developers que usen Claude Code o Codex activamente. Canales: r/LocalLLaMA, r/ClaudeAI, Discord de Anthropic, comunidad de Indie Hackers
- [ ] **Entrevistar a los primeros usuarios** — ¿qué agente usan? ¿han perdido trabajo por el agente? ¿qué les daría más confianza?
- [ ] **Landing page actualizada** — la actual en Venture Swarm es genérica. Necesita reflejar el producto real que existe hoy.

### Estratégico
- [ ] **Lanzamiento Product Hunt / HN "Show HN"** — cuando esté estable con betas. Objetivo: 100+ stars en GitHub, primeros downloads reales.
- [ ] **Decidir el modelo de monetización** — Free local / Pro cloud $9/mes / Team $29/mes. ¿Cuándo activar Stripe?
- [ ] **Nombre de dominio** — `agentguard.dev` u otra opción. Definir antes del lanzamiento público.

---

## Orden lógico de próximos pasos

```
1. Rollback automático en deny           ← arregla el bug más crítico
2. Diff preview antes de aprobar         ← hace el producto realmente útil
3. README + GIF demo                     ← sin esto no hay nada que mostrar
4. GitHub público                        ← base para todo lo demás
5. 5 beta testers                        ← validación real
6. Contexto de intención (MVP)           ← el diferenciador clave
7. Lanzamiento HN / Product Hunt         ← tracción
8. Backend + Stripe                      ← monetización
```

---

*AgentGuard — Guardrails for AI coding agents before they wreck your repo.*
