# Fuente del frontend (sictox-rubi)

Esto es el código fuente real del dashboard. Los archivos en la raíz del repo
(`index.html`, `assets/*.js`) son el **build compilado** — no se editan a mano.

## Flujo correcto tras editar `src-app/src/App.jsx`

```
cd src-app
npm install        # solo la primera vez
npm run build      # genera src-app/dist/
```

Luego sube `dist/index.html` y `dist/assets/*.js` a la **raíz** del repo
(reemplazando los anteriores) y borra el bundle antiguo si el hash cambió.
GitHub Pages (Actions) republica automáticamente al hacer push a `main`.

⚠️ Si solo editas `App.jsx` y no repites este paso, el dashboard en producción
seguirá sirviendo el bundle antiguo — esto ya pasó una vez (bug de ruta
`./public/data.json` vs `./data.json`, corregido en el código pero nunca
recompilado/desplegado).
