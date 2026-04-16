# Coastal Rain Prototype

A lightweight prototype web app for short-term coastal rain prediction.

It follows the flow we discussed:
1. Upload a horizon photo.
2. Capture GPS location.
3. Pull current weather from Open-Meteo.
4. Combine those inputs in an analysis step.
5. Return a 1–2 hour rain probability with reasoning.

## Run locally

```bash
node server.js
```

Then open <http://localhost:8000> (or `http://localhost:$PORT` if you set the `PORT` environment variable).

## Notes

- The current `/api/analyze` endpoint is a deterministic prototype heuristic using weather signals (humidity, pressure, precipitation, wind).
- It is structured so you can later replace that step with a real vision model call.
- Weather data source: Open-Meteo Forecast API.

## Next steps

- Add a real AI vision backend (OpenAI/other).
- Store user feedback (`rain arrived` / `stayed dry`) to improve local calibration.
- Add optional radar context.
