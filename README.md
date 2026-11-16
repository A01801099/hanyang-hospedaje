# Hospedaje cerca de Hanyang (Seúl)

Mapa con pin en la Universidad Hanyang, filtros (Hotel tradicional / Airbnb / Cápsula),
precio por noche y total, y botón de reserva. Dos estancias:

| Estancia | Entrada | Salida | Por qué |
|---|---|---|---|
| 1 | 24-dic-2026 | 25-dic-2026 | Aterrizan el 24 y la residencia abre el 25 |
| 2 | 4-feb-2027 | 6-feb-2027 | Check-out de la residencia (A&B) y vuelo el 6 a las 11:40 |

Las fechas se pueden cambiar en el sitio (por si eligen la Sesión A, que sale el 9-ene).

## Cómo correrlo

```bash
cd hanyang-stays
cp .env.example .env      # y pon tu SERPAPI_KEY
node server.js            # Node 18+; no hay que instalar paquetes
# abre http://localhost:3000
```

Sin `SERPAPI_KEY` corre en **modo DEMO** (datos de ejemplo marcados con [DEMO]).

## De dónde salen los precios

El navegador pide `/api/stays` y `server.js` consulta **SerpApi → Google Hotels** en ese momento
(con caché de 1 h para cuidar la cuota). La API key vive solo en el servidor.

- Hoteles: búsqueda "hotels near Hanyang University Seoul"
- Cápsulas: búsqueda "capsule hotel near …" + palabras clave en el nombre (capsule, pod, hostel…)
- Airbnb: motor `airbnb` de SerpApi (anuncios reales, con enlace directo, buscados por área alrededor de Hanyang; 1ª página, hasta 18)

### Limitaciones a tener en cuenta

- Airbnb no tiene API pública; SerpApi lo extrae de los resultados de búsqueda. El precio es el total de la estancia dividido entre las noches; confirma tarifas de limpieza e impuestos en Airbnb.
- La categoría "cápsula" es una heurística por nombre; revísenla.
- El botón "Reservar" lleva al sitio del alojamiento o a la oferta en Google Hotels; el precio es de referencia.
- Revisa la cuota del plan gratuito de SerpApi: cada carga de una estancia usa 3 búsquedas (2 de Google Hotels + 1 de Airbnb).

## Publicarlo

Necesita un servidor Node (Render, Railway, Fly.io…) porque la key no puede ir en un sitio estático.
Define `SERPAPI_KEY` como variable de entorno en el panel del servicio, no la subas a GitHub.
