# AgentGuard — Plan Técnico Completo
**Versión 1.0 | Marzo 2026**

---

## El Problema

Cuando corres un agente de IA como Codex o Claude Code, el agente tiene acceso completo a tu shell. Puede:

- Ejecutar `rm -rf src/` sin avisarte
- Sobrescribir tu archivo `.env` con valores incorrectos
- Correr `git reset --hard` y destruir trabajo sin commitear
- Hacer `git push --force` a main
- Modificar `package.json`, archivos de CI/CD, Dockerfiles
- Ejecutar scripts con permisos elevados

El agente actúa de buena fe pero comete errores. Y cuando te das cuenta, el daño ya está hecho.

---

## La Solución

AgentGuard es un wrapper de shell universal que se coloca entre tú y cualquier agente de IA. Hace lo siguiente:

1. **Intercepta** cada comando antes de ejecutarse
2. **Clasifica** el nivel de riesgo en tiempo real
3. **Pone en cola** las operaciones riesgosas para tu aprobación (con vista previa del diff)
4. **Hace rollback** automáticamente vía git si algo sale mal

---

## Arquitectura

```
┌─────────────────────────────────────────────────────┐
│            Agente de IA (Codex / Claude)             │
└────────────────────────┬────────────────────────────┘
                         │ comandos shell / operaciones de archivo
                         ▼
┌─────────────────────────────────────────────────────┐
│           Wrapper de Shell de AgentGuard            │
│   (intercepta TODOS los comandos antes de ejecutar) │
└────────┬───────────────┬──────────────┬─────────────┘
         │               │              │
         ▼               ▼              ▼
  [Clasificador]  [Git Snapshot]  [File Watcher]
         │
    ┌────┴─────┐
    │          │
  SEGURO    RIESGOSO
    │          │
 Ejecuta   Cola de Aprobación
             │
         ┌───┴────┐
         │        │
      APROBAR  DENEGAR
         │        │
      Ejecuta  Rollback
                  │
            git restore
```

---

## Componentes Principales

### 1. Shell Interceptor
El corazón del sistema. En lugar de dejar que el agente hable directo con `/bin/zsh`, AgentGuard actúa como proxy:

```
agente → agentguard-shell → [clasificar] → /bin/zsh (o bloquea)
```

El agente se lanza con `SHELL=/usr/local/bin/agentguard-shell`. AgentGuard-shell es un PTY wrapper que parsea cada comando antes de ejecutarlo.

**Comandos que disparan aprobación:**
- `rm`, `rmdir`, `unlink` → BORRAR
- `git reset --hard` → GIT DESTRUCTIVO
- `git push --force` → GIT FORCE PUSH
- `git clean -fd` → GIT CLEAN
- `chmod 777`, `chown` → CAMBIO DE PERMISOS
- `> archivo` (truncar) → TRUNCAR ARCHIVO
- `curl | bash`, `wget | sh` → EJECUCIÓN REMOTA

**Archivos que disparan aprobación si se modifican:**
- `.env`, `.env.*`
- `*.pem`, `*.key`, `id_rsa`
- `package.json`, `package-lock.json`
- `Dockerfile`, `docker-compose.yml`
- `.github/workflows/**`
- `*.config.js`, `*.config.ts`
- Archivos de base de datos (`*.db`, `*.sqlite`)

---

### 2. Clasificador de Riesgo

**Nivel 1 — Reglas determinísticas (regex / pattern matching)**
Rápido, offline, cero latencia. Cubre el 80% de los casos.

```javascript
const reglas = [
  { pattern: /^rm\s+-rf?\s+/, nivel: 'CRITICAL', razon: 'Borrado recursivo' },
  { pattern: /^git\s+reset\s+--hard/, nivel: 'HIGH', razon: 'Destruye trabajo sin commitear' },
  { pattern: />\s*\.env/, nivel: 'HIGH', razon: 'Sobrescribe archivo .env' },
  { pattern: /^git\s+push.*--force/, nivel: 'CRITICAL', razon: 'Force push al remoto' },
]
```

**Nivel 2 — Scoring con contexto (fase posterior)**
- ¿El archivo que se va a borrar tiene cambios sin commitear?
- ¿Cuántos archivos afecta esta operación?
- ¿Es la primera vez que el agente toca este archivo?
- ¿El repo tiene CI/CD que se puede romper?

Puntaje de riesgo 0–100 → umbral configurable por el usuario.

---

### 3. Cola de Aprobación + Rollback

**Flujo de aprobación en la terminal:**

```
⚠️  AgentGuard interceptó una operación de alto riesgo:

  Agente:    Codex (sesión #4821)
  Comando:   rm -rf ./src/utils/
  Riesgo:    CRÍTICO — Borrado recursivo (4 archivos, 312 líneas)
  Archivos:  formatters.ts, validators.ts, helpers.ts, index.ts

  [A] Aprobar    [D] Denegar    [S] Snapshot + Aprobar    [?] Ver diff completo
```

**Sistema de rollback:**
```bash
# Al inicio de cada sesión de agente, AgentGuard ejecuta:
git stash -u -m "agentguard-snapshot-{timestamp}"

# Si se niega una operación o algo sale mal:
git stash pop  # o git checkout -- .
```

Para repos sin git inicializado, crea un snapshot en `~/.agentguard/snapshots/`.

---

## Stack Tecnológico

| Componente | Tecnología | Por qué |
|---|---|---|
| Shell interceptor | **Rust** (v2) / Node.js (v0) | Baja latencia, acceso a syscalls |
| Motor de reglas | Node.js | Rápido de iterar |
| CLI / TUI | **Ink** (React para terminal) | TUI elegante sin boilerplate |
| Dashboard web (v2) | **Next.js + shadcn/ui** | Rápido de construir |
| Almacenamiento local | **SQLite** vía Drizzle | Sin deps externas, funciona offline |
| Notificaciones | Telegram Bot API | Ya integrado con OpenClaw |
| Distribución | npm + Homebrew tap | Donde viven los devs |

---

## Hoja de Ruta

### 🟢 FASE 0 — Fundación (Días 1–3)
**Objetivo: Prueba de concepto funcional**

- [ ] Repo `agentguard` en GitHub
- [ ] Wrapper de shell básico en Node.js
- [ ] 20 reglas de detección (los casos más comunes)
- [ ] Flujo de aprobación en CLI (prompt simple)
- [ ] Git snapshot automático al inicio de sesión
- [ ] Probarlo tú mismo con Codex en un proyecto real

**Entregable:** Puedes correr `agentguard codex` en lugar de `codex` y el sistema te pide aprobación para operaciones riesgosas.

---

### 🟡 FASE 1 — MVP Usable (Semanas 1–2)
**Objetivo: Algo que otros puedan instalar**

- [ ] `npm install -g agentguard` funcional
- [ ] Archivo de config (`agentguard.config.json`) por proyecto
- [ ] 50+ reglas de detección
- [ ] TUI con vista previa del diff (Ink)
- [ ] Log de auditoría en SQLite
- [ ] README y documentación básica
- [ ] Soporte para: Codex, Claude Code, aider, Continue

**Entregable:** Beta privada con 5–10 personas de la waitlist.

---

### 🟠 FASE 2 — Tracción (Semanas 3–6)
**Objetivo: Usuarios reales, feedback real**

- [ ] Dashboard web local (`agentguard dashboard` → localhost:3000)
  - Ver historial de sesiones
  - Aprobar operaciones desde el browser (útil cuando el agente corre en background)
  - Estadísticas: operaciones bloqueadas, tiempo ahorrado
- [ ] Notificaciones por Telegram/Discord para aprobaciones remotas
- [ ] Scoring de riesgo inteligente (contexto del repo)
- [ ] Soporte MCP (Model Context Protocol) — AgentGuard como tool dentro del agente
- [ ] Lanzamiento en Product Hunt + HN "Show HN"

---

### 🔵 FASE 3 — Monetización (Meses 2–3)
**Objetivo: Ingresos**

- [ ] **AgentGuard Cloud** — sincroniza reglas y log de auditoría entre máquinas
- [ ] **Plan Team** — múltiples aprobadores, roles (quién puede aprobar qué)
- [ ] **Plantillas de políticas** por tipo de proyecto (startup, open-source, fintech)
- [ ] **Integración CI/CD** — AgentGuard como GitHub Action
- [ ] Precios: Gratis (local, básico) / Pro $9/mes / Team $29/mes

---

## Estrategia de Testing

### Testing Técnico
```
1. Unit tests — cada regla de detección
   input: "rm -rf ./src" → resultado esperado: CRITICAL

2. Integration tests — sesión de agente simulada
   Simula un agente corriendo comandos, verifica que AgentGuard los intercepta

3. Tests en el mundo real — úsalo tú mismo
   Corre Codex en un proyecto de prueba con bugs intencionales,
   verifica que AgentGuard atrapa las ops destructivas

4. Chaos testing — agente "malicioso"
   Script que intenta 30 operaciones destructivas,
   AgentGuard debe atrapar el 100%
```

### Testing de Mercado (ya corriendo en Venture Swarm)
- Landing page activa: https://bit.ly/4dFBaBY
- Meta: 100 signups en 7 días
- 50+ signups → señal clara de interés real
- Entrevistar a los primeros 10 signups para entender su pain point específico

---

## Panorama Competitivo

| Herramienta | Qué hace | Diferencia con AgentGuard |
|---|---|---|
| Codex `--permission-mode` | Pide permiso para algunas ops | Solo funciona en Codex, no es universal |
| Claude Code `--allowedTools` | Restringe qué tools usa el agente | Demasiado restrictivo, no granular |
| git pre-commit hooks | Atrapa en el momento del commit | Demasiado tarde para ops destructivas |
| **Ninguna** | Monitoreo cross-agente con rollback automático | **Eso es AgentGuard** |

**Diferenciador clave:** Es el único que funciona con CUALQUIER agente, tiene rollback automático y muestra vista previa del diff antes de que apruebes.

---

## Riesgos y Mitigaciones

| Riesgo | Mitigación |
|---|---|
| El interceptor añade latencia | Core en Rust, async por defecto |
| Falsos positivos (bloquea cosas seguras) | Config granular, modo "solo auditoría" |
| El agente hace bypass del shell wrapper | Monitoreo a nivel filesystem como fallback |
| Los propios agentes construyen esto | Tienen conflicto de interés — no lo harán bien |

---

## Branding y Dominio

- **Principal:** `agentguard.dev`
- **Alternativas:** `guardagent.sh`, `agentfence.dev`, `codeguard.ai`
- **Concepto de logo:** Un escudo con el ícono de un robot/agente adentro
- **Tagline:** "Guardrails for AI coding agents before they wreck your repo."

---

## Métricas de Éxito

| Métrica | Fase 0 | Fase 1 | Fase 2 |
|---|---|---|---|
| Stars en GitHub | — | 100 | 500+ |
| Instalaciones npm/semana | — | 50 | 500+ |
| Signups por email | 100 (landing) | 200 | 1,000+ |
| Revenue | $0 | $0 | $500+/mes |

---

## Notas Personales (espacio para tus apuntes)

```
Fecha: ____________

Preguntas que tengo:
- 
- 
- 

Ideas propias:
- 
- 

Prioridades para esta semana:
1. 
2. 
3. 
```

---

*AgentGuard — Construido en público. Validado por la comunidad.*
*Landing page: https://bit.ly/4dFBaBY*
