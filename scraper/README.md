# Scraper de Totoya

Genera `site/data/events.json` (el calendario) y `site/data/report.json` (diagnóstico).

## Cómo funciona

`node scraper/run.mjs`:

1. Lee `config/settings.yml` y `config/sources.yml`.
2. Para cada fuente activa (`enabled: true`) ejecuta `scraper/sources/<id>.mjs` (3 a la vez, máximo 3 minutos cada una). Si falta el archivo, la fuente se salta.
3. Limpia los eventos: quita HTML, descarta los que no tienen título, fecha o enlace, deja solo los próximos 75 días (`horizonDays`) y elimina duplicados (mismo título + día + lugar).
4. Clasifica cada evento (asistir/participar, categoría, resumen, zona, precio, accesibilidad, persona mayor) y descarta lo que no le sirve a Totoya: caminatas, deportes, actividades solo para niños, eventos solo virtuales y eventos fuera de Bogotá.
   - Con `OLLAMA_API_KEY` usa la IA de Ollama Cloud (`gemma4:31b`, y si falla, `gpt-oss:20b`).
   - Sin clave, o si la IA falla, usa un clasificador por palabras clave (`lib/keywords.mjs`). El sitio se actualiza igual.
   - Las respuestas de la IA se guardan en `scraper/.cache/classify.json`, así no se repite el trabajo con eventos que no han cambiado.
5. Agrega los lugares de `config/places.yml` y sus actividades repetidas (por ejemplo, el mercado de Usaquén los domingos).
6. Si una fuente falla o no trae nada, se conservan sus eventos futuros de la semana anterior.

La GitHub Action (`.github/workflows/update.yml`) corre cada lunes a las 5:00 a. m. (hora de Bogotá), guarda los datos en el repositorio y publica el sitio. Para correrla a mano: pestaña **Actions → Actualizar y publicar → Run workflow**. Un push a `main` solo vuelve a publicar el sitio, sin buscar eventos nuevos.

## Correrlo en el computador

```bash
npm ci
node scraper/run.mjs --no-ai            # sin IA
OLLAMA_API_KEY=... node scraper/run.mjs # con IA
node scraper/run.mjs --only=banrep,mambo --dry   # solo esas fuentes; muestra cifras sin escribir archivos
node --test "scraper/test/*.test.mjs"   # pruebas
```

Opciones: `--only=id,id` (solo esas fuentes; las demás conservan sus eventos anteriores), `--no-ai` (solo palabras clave), `--dry` (no escribe nada).

Para revisar qué pasó con cada fuente, mira `site/data/report.json`: estado (`ok`, `empty`, `failed`, `timeout`, `missing`), cuántos eventos trajo, cuántos se descartaron y por qué.

## Agregar una fuente

1. Agrega una línea en `config/sources.yml` con un `id` nuevo.
2. Crea `scraper/sources/<id>.mjs` con `export async function scrape(ctx)` que devuelva una lista de eventos (`title`, `url`, `start` y, si hay, `end`, `venueName`, `address`, `priceText`, `description`, `tags`, `image`). El formato exacto está en `docs/DESIGN.md` (Contrato 1).
3. Pruébala con `node scraper/run.mjs --only=<id> --no-ai --dry`.

Para desactivar una fuente sin borrarla: `enabled: false`.

## Agregar un lugar

Edita `config/places.yml` (se puede hacer desde github.com). Copia un lugar existente y cambia los datos. Si algo no es seguro, escribe "(verificar)" o usa `desconocida`/`desconocido` en accesibilidad. Para actividades que se repiten (cada domingo, el último domingo del mes…), usa `recurring:`; los campos se explican al principio del archivo. Después corre la Action a mano para que aparezca en el sitio.

## Clave de Ollama (`OLLAMA_API_KEY`)

1. Crea una clave en <https://ollama.com/settings/keys>.
2. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**, con el nombre `OLLAMA_API_KEY` y la clave como valor.

Sin la clave todo funciona igual, pero con el clasificador por palabras clave (menos preciso, y los resúmenes se toman de la descripción original). Los modelos se cambian en `config/settings.yml`.
