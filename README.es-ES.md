

![Finn hero](assets/finn_hero.png)

# Finn

Una inteligencia más personal, en una interfaz que ya usas todos los días.

Finn es un compañero de IA que vive en iMessage. No requiere descargar una app, no hay un panel de control que aprender, ni prompts que dominar. Simplemente está ahí, en el mismo lugar al que ya vas para hablar con la gente, y está diseñado para sentirse como uno de ellos: alguien que te conoce, recuerda lo que importa y se encarga de las cosas en segundo plano sin que lo notes.

Finn forma parte del [Personal Intelligence Project](https://personalintelligenceproject.com).

> **Modelos recomendados:** **Opus (4.6 o 4.8)** en la ruta principal (hot path), **Kimi (2.6)** para todo lo demás. Finn fue optimizado para esta combinación. Opus transmite mejor la personalidad (adopta la identidad de Finn como algo central, no como una máscara superficial) y razona bien sobre el tiempo (hora actual, marcas de tiempo de memoria y mensajes), mientras que Kimi maneja el trabajo pesado en segundo plano de forma económica. Ambos son compatibles con visión y resisten bien en ejecuciones agenticas largas. Consulta [Modelos recomendados](#recommended-models).

## Qué hace a Finn, Finn

Esto no es un prompt de sistema pegado a una API. El trabajo está en las partes que no ves.

- **Una voz que pasó por más de 300 iteraciones.** La identidad de Finn fue escrita, evaluada, revisada y reescrita cientos de veces, basándose en investigaciones recientes sobre interacción humano-IA natural y segura. El objetivo fue eliminar los rasgos típicos de la IA: sin relleno genérico, sin tics verbales, sin narrar sus propios procesos internos. Reacciona antes de informar, bromea con la situación y no con la persona, y suena como un amigo ágil en un chat grupal en lugar de un bot de soporte.
- **La ruta principal (hot path) está siempre activa.** Un agente dedicado gestiona la conversación en vivo y responde al instante, mientras que cualquier tarea lenta (investigación, archivos, tareas de múltiples pasos) se ejecuta en trabajadores de segundo plano que reportan resultados. Tú sigues enviando mensajes; el trabajo sucede en segundo plano.
- **El contexto como un presupuesto, no como un vertedero.** Las herramientas y documentos se buscan y cargan bajo demanda en lugar de abarrotar cada prompt, el historial se compacta a medida que crece, las salidas grandes de herramientas se desbordan a artefactos, y la recuperación de memoria está limitada y es tolerante a fallos. Las ejecuciones largas permanecen estables.
- **Modo código.** En lugar de docenas de herramientas nativas, los trabajadores obtienen un entorno de ejecución JavaScript aislado (`workspace_search` / `workspace_execute`) sobre un único objeto tipado `finn` (`finn.files.*`, `finn.patterns.*`, `finn.web.*`, y más). Escriben un script breve, invocan las APIs que encuentran y devuelven un valor. Componible, descubrible y contenido dentro del límite del espacio de trabajo.
- **Memoria que permanece detrás de un límite.** La memoria a largo plazo se ejecuta a través de un proveedor ([Honcho](https://honcho.dev) recomendado), pero nunca se filtra en el chat: la recuperación está sanitizada y Finn nunca anuncia que está "revisando su memoria".
- **Sensación de compañero único, arquitectura multiusuario.** Entornos de ejecución con alcance de inquilino y usuario, espacios de trabajo aislados, conectores con alcance específico y acceso por números permitidos. Ejecútalo para ti mismo o configúralo para amigos y familia sin un contexto global compartido y desordenado.

También ejecuta **Patterns** (automatizaciones programadas y activadas por conectores con historial real de ejecución), se conecta a tus herramientas a través de **Composio**, **MCP** y la app **Puter** para macOS, y viene con un **panel web** para el perfil, conectores, Patterns y My Day.

## Configuración

> **Importante:** Finn necesita una URL HTTPS pública para funcionar. Spectrum/iMessage, el panel web, la entrega de archivos y los webhooks de conectores dependen de ella. Si no estás alojando en un servidor con un dominio público, coloca un túnel delante (Cloudflare Tunnel, Tailscale Funnel, ngrok, etc.) y configura `PUBLIC_URL` con esa dirección. Una configuración puramente en localhost no funcionará completamente.

La ruta recomendada es Docker Compose con Postgres incluido y [Honcho](https://honcho.dev) gestionado para la memoria. Honcho gestionado solo necesita una clave API, por lo que la pila de producción permanece pequeña.

```bash
git clone <repo-url>
cd <repo-dir>
cp .env.example .env
```

Edita `.env` (al menos los valores en [Configuración](#configuration) a continuación, incluyendo `MEMORY_PROVIDER=honcho` y tu `HONCHO_API_KEY`), y luego inicia Finn:

```bash
docker compose -f docker-compose.no-cloudflared.yml up -d --build
```

Para ejecutar la misma pila detrás de un Cloudflare Tunnel, configura `CLOUDFLARE_TUNNEL_TOKEN` en `.env` y usa la pila de túnel incluida en su lugar:

```bash
docker compose up -d --build
```

Los archivos compose utilizan `expose` de Docker en lugar de puertos fijos del host, lo cual funciona bien en hosts gestionados como Dokploy. Dirige tu proxy al servicio `finn` en el puerto de contenedor `3000`. Si estás ejecutando localmente y quieres acceso directo al host, usa `docker-compose.dev.yml` o añade una pequeña anulación con `ports: ["3000:3000"]`.

> ¿Prefieres memoria autohospedada? Finn también admite Hindsight, Supermemory y Mem0. Para una pila completamente autónoma con un contenedor Hindsight incluido, usa `docker-compose.hindsight.yml` y consulta [Operaciones de Memoria Hindsight](docs/operations/hindsight-memory.mdx).

## Configuración

Al menos, configura estos en `.env`:

```env
PUBLIC_URL=https://your-finn-domain.example

SPECTRUM_PROJECT_ID=your-spectrum-project-id
SPECTRUM_PROJECT_SECRET=your-spectrum-project-secret
SPECTRUM_ALLOWED_NUMBERS=+15551234567

DEFAULT_PROVIDER=anthropic
DEFAULT_MODEL=anthropic:claude-opus-4-6
DEFAULT_API_KEY=your-provider-api-key

MEMORY_PROVIDER=honcho
HONCHO_API_KEY=your-honcho-api-key
```

Para endpoints compatibles con OpenAI, usa `DEFAULT_PROVIDER=openai-compatible`, configura `DEFAULT_MODEL=openai-compatible:<nombre-modelo>` y apunta `DEFAULT_BASE_URL` a la URL base del endpoint incluyendo `/v1`. `DEFAULT_API_KEY` es opcional solo cuando el endpoint no requiere autenticación. Finn establece `LLM_FORCE_TOOL_CHOICE` en `false` por defecto para modelos compatibles con OpenAI, ya que algunas pasarelas rechazan la elección de herramienta obligatoria mientras aún aceptan llamadas de herramientas opcionales.

Configuraciones opcionales útiles:

| Variable | Uso |
| --- | --- |
| `POSTGRES_PASSWORD` | Contraseña para la base de datos Postgres incluida de Finn. Por defecto es `finnpass`; cámbiala fuera de demostraciones locales. |
| `MEMORY_MODE` | `hybrid` inyecta recuperación compacta y expone herramientas de memoria. `context` inyecta solo recuperación. `tools` expone solo herramientas. |
| `HONCHO_BASE_URL` | Dirige Finn a un despliegue autohospedado de Honcho en lugar de Honcho gestionado. |
| `HONCHO_WORKSPACE_PREFIX` | Prefijo para los IDs de espacio de trabajo de Honcho creados por Finn. Por defecto es `finn`. |
| `HONCHO_TIMEOUT_MS` | Tiempo de espera de solicitud del SDK de Honcho. Por defecto es `30000`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Requerido al ejecutar la pila de Cloudflare Tunnel incluida. |
| `ADMIN_BEARER_TOKEN` | Protege los endpoints de administración. Recomendado para instancias desplegadas. |

Consulta [Configuración](docs/operations/configuration.mdx), [Despliegue](docs/operations/deployment.mdx) y [Operaciones de Memoria Honcho](docs/operations/honcho-memory.mdx) para la referencia completa.

## Modelos recomendados

Finn fue refinado y optimizado alrededor de una combinación específica, y el trabajo de personalidad anterior lo da por sentado: **Opus (4.6 o 4.8) en la ruta principal (hot path), y Kimi (2.6) para todo lo demás.**

La ruta principal es donde reside la voz, y la elección del modelo importa más allí que en cualquier otro lugar. En las pruebas, los modelos Opus adoptaron la identidad de Finn como algo central en lugar de usarla como una máscara superficial, y ofrecieron el rango más amplio y natural: humor, franqueza, actitud y un vocabulario genuinamente amplio en lugar de la misma puñado de tics. También fueron notablemente mejores en el **razonamiento temporal**, incorporando de hecho la hora actual, las marcas de tiempo de la memoria y las marcas de tiempo en el historial de conversaciones, por lo que las respuestas parecen conscientes del tiempo en lugar de sonar como un chatbot superficial respondiendo en el vacío. Tanto Opus como Kimi son modelos de visión, lo que mantiene a Finn capaz de trabajar con imágenes, y ambos resisten bien en ejecuciones agenticas largas.

Una nota sobre Sonnet: Sonnet 4.6 tenía tendencia a emitir llamadas de herramientas como XML sin procesar en el texto en lugar de invocar realmente las herramientas, por lo que no se recomienda para la ruta principal de Finn.

Configura la combinación recomendada con anulaciones por proceso en `.env`:

```env
# Hot path: personalidad + razonamiento temporal + visión
HOT_PATH_PROVIDER=anthropic
HOT_PATH_MODEL=anthropic:claude-opus-4-6
HOT_PATH_API_KEY=your-anthropic-key

# Workers + compactador: Kimi para todo lo demás
WORKER_PROVIDER=openai-compatible
WORKER_MODEL=openai-compatible:kimi-2.6
WORKER_BASE_URL=https://your-kimi-endpoint/v1
WORKER_API_KEY=your-kimi-key

COMPACTOR_PROVIDER=openai-compatible
COMPACTOR_MODEL=openai-compatible:kimi-2.6
COMPACTOR_BASE_URL=https://your-kimi-endpoint/v1
COMPACTOR_API_KEY=your-kimi-key
```

Usa los identificadores exactos de modelo y los endpoints de tu proveedor; los valores anteriores son ilustrativos. Cualquier proceso sin una anulación vuelve a `DEFAULT_PROVIDER` / `DEFAULT_MODEL`. Para endpoints compatibles con OpenAI (como una pasarela de Kimi), incluye el prefijo `/v1` en la URL base; Finn ya relaja `LLM_FORCE_TOOL_CHOICE` para esos modelos.

## Tras el arranque

1. Dirige tu ruta pública o túnel a Finn en el puerto `3000`.
2. Asegúrate de que `PUBLIC_URL` coincida exactamente con esa URL HTTPS pública.
3. Configura Spectrum con las credenciales de tu proyecto y los números de teléfono permitidos.
4. Abre el panel web en `PUBLIC_URL` para revisar el perfil, conectores, Patterns y My Day.
5. Envía un mensaje a Finn desde un número permitido.

La entrada de iMessage de Spectrum utiliza el flujo de mensajes persistente de Spectrum. Finn no requiere un webhook de Spectrum para mensajes entrantes.

Si habilitas conectores respaldados por Composio o Patterns activados por eventos, también configura:

```env
COMPOSIO_API_KEY=your-composio-key
COMPOSIO_CALLBACK_URL=https://your-finn-domain.example/connectors
COMPOSIO_WEBHOOK_SECRET=your-webhook-secret
```

Luego, configura la URL de suscripción del webhook de Composio como:

```text
https://your-finn-domain.example/webhooks/composio
```

## App web

![Finn web app](assets/web_app_hero.png)

La app web es la superficie de control discreta alrededor del compañero de iMessage. Úsala para configurar detalles del perfil, gestionar conectores, revisar My Day, crear y editar Patterns, inspeccionar ejecuciones recientes de Patterns y volver a enviarle mensajes a Finn desde la línea de Spectrum correcta.

Reside en `packages/web` y está construida con Vite y React. En despliegues Docker, se incluye en el servidor de Finn y se sirve desde la misma `PUBLIC_URL`.

```bash
bun run web:dev
bun run web:build
```

Nota de diseño: la app web está fuertemente inspirada en [Poke de The Interaction Company](https://poke.com). Un gran reconocimiento para ellos. Por favor, no nos demanden.

## Puter

Puter es la app compañera de Finn para macOS. Empareja una Mac con Finn para que la Inteligencia Personal pueda inspeccionar fuentes exclusivas de local, como iMessage y Notas, con el permiso del usuario, a través de comandos en vivo.

La primera implementación es intencionalmente limitada: emparejar la app de Mac, exponer interruptores para iMessage y Notas, permitir que las ejecuciones de Inteligencia Personal con consentimiento inspeccionen esas fuentes mientras la app está en línea, y retener solo un entendimiento duradero seleccionado a través de la ruta normal de memoria. No es una capa de control general de la computadora, y nunca carga por lotes registros locales al servidor.

Puter reside en `packages/puter` como una app de barra de menú Tauri. Consulta [Puter](docs/features/puter.mdx) para configuración, permisos y notas de compilación.

## Desarrollo local

Instala las dependencias con Bun:

```bash
bun install
```

Ejecuta Finn directamente contra un Postgres local:

```bash
docker compose up postgres -d
bun run db:push
bun run dev
```

O ejecuta la pila compose de desarrollo local:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Comandos comunes:

| Comando | Descripción |
| --- | --- |
| `bun run dev` | Inicia el servidor con recarga en caliente |
| `bun run start` | Inicia el servidor en modo producción |
| `bun run build` | Compila la app web y empaqueta el servidor |
| `bun run check` | Verifica tipos de todos los paquetes |
| `bun run test` | Ejecuta el suite de pruebas de Bun |
| `bun run db:generate` | Genera migraciones de Drizzle |
| `bun run db:migrate` | Ejecuta migraciones pendientes |
| `bun run db:push` | Empuja cambios de esquema directamente |
| `bun run web:dev` | Ejecuta el servidor de desarrollo del panel web |
| `bun run docs:dev` | Previsualiza la documentación localmente |

## Cómo se integra todo

```text
iMessage
  <-> Spectrum
  <-> Finn Server
        |-- Hot-path agent        (always-on live conversation)
        |-- Background workers     (slow / tool-heavy work)
        |-- Pattern scheduler      (scheduled + triggered automations)
        |-- Runtime services
        |     |-- files
        |     |-- memory (Honcho)
        |     |-- Composio
        |     |-- MCP
        |     `-- Puter
        `-- Postgres
```

El agente de ruta principal gestiona la conversación en vivo. Los trabajadores manejan el trabajo lento y pesado en herramientas detrás de escena. Patterns almacena automatizaciones programadas y activadas por conectores. Postgres contiene usuarios, contexto de perfil, conversaciones, archivos, trabajadores, Patterns, ejecuciones de Patterns y My Day. El proveedor de memoria añade recuperación a largo plazo encima.

## Mapa del repositorio

```text
identity/             Prompts de personalidad y voz de Finn
prompts/              Instrucciones de procesos de agentes
docs/                 Documentación Mintlify
docker/               Punto de entrada del contenedor e imagen de sandbox
packages/core/        Configuración compartida, tipos, registrador, bus de eventos, utilidades
packages/db/          Esquema Drizzle y cliente Postgres
packages/llm/         Capa de LLM agnóstica al proveedor
packages/agents/      Agentes de ruta principal, trabajadores y compactadores
packages/tools/       Definiciones de herramientas de ruta principal y trabajadores
packages/toolsets/    Conjuntos de herramientas del espacio de trabajo JS de Finn (modo código)
packages/messaging/   Adaptador Spectrum, enrutamiento y remitente
packages/media/       STT, TTS, almacenamiento y procesamiento de adjuntos
packages/patterns/    Almacenamiento de Patterns, programador e historial de ejecución
packages/runtime/     Límites de entorno de ejecución de usuario y proceso
packages/integrations/ Servicios externos: Honcho, Composio, MCP, web Exa/Parallel, medios Fal/xAI
packages/web/         Panel Vite/React
packages/puter/       App compañera Tauri para macOS
packages/server/      Servidor Hono, rutas, inicio y conexión de eventos
```

## Documentación

- [Inicio rápido](docs/guides/quickstart.mdx)
- [Arquitectura](docs/concepts/architecture.mdx)
- [Agentes](docs/concepts/agents.mdx)
- [Memoria](docs/concepts/memory.mdx)
- [Conectores y Patterns](docs/features/connectors-and-patterns.mdx)
- [Inteligencia Personal y My Day](docs/features/personal-intelligence-and-my-day.mdx)
- [Configuración](docs/operations/configuration.mdx)
- [Despliegue](docs/operations/deployment.mdx)
- [Operaciones de Memoria Honcho](docs/operations/hindsight-memory.mdx)

Las notas del flujo de trabajo de contribuyentes están en [CONTRIBUTING.md](CONTRIBUTING.md).

## Pila tecnológica

- [Bun](https://bun.sh) y TypeScript
- [Hono](https://hono.dev)
- [Vercel AI SDK](https://sdk.vercel.ai)
- [PostgreSQL](https://www.postgresql.org) y [Drizzle ORM](https://orm.drizzle.team)
- [Photon Spectrum](https://docs.photon.codes/spectrum-ts/getting-started.md)
- [Honcho](https://honcho.dev) para la configuración de memoria recomendada
- [Composio](https://composio.dev), MCP y telemetría PostHog donde esté configurado

## Licencia

Finn es software de código abierto licenciado bajo la Licencia Pública General Afirmativa de GNU versión 3 o posterior. Consulta [LICENSE](LICENSE) para el texto completo y [NOTICE](NOTICE) para la atribución del proyecto.

Las versiones alojadas o modificadas de Finn deben cumplir con la AGPL, incluyendo los requisitos de disponibilidad del código fuente para servicios de red.

---

Desarrollado por el [Personal Intelligence Project](https://personalintelligenceproject.com).
