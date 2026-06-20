# SicAir · SicTox — EDAR Rubí

Dashboard de control de aireación y toxicidad para EDAR Rubí.  
Desarrollado por [Sensara](https://sensaratech.com) · Logroño, La Rioja.

## Arquitectura

```
PC SN8 (MySQL local)
  └─ sync_rubi.py  →  public/data.json  →  GitHub Pages  →  navegador
```

## Instalación en el PC del SN8

### 1. Instalar Python
Descargar de https://www.python.org/downloads/ — marcar **"Add Python to PATH"** durante la instalación.

### 2. Descargar los archivos de sync
Copiar en el PC del SN8 la carpeta con:
- `sync_rubi.py`
- `instalar_y_ejecutar.bat`
- `ejecutar_sync.bat`

### 3. Configurar contraseña MySQL
Abrir `sync_rubi.py` con el Bloc de notas y cambiar:
```python
MYSQL_PASSWORD = "TU_PASSWORD_AQUI"   # ← poner la contraseña real
```

### 4. Primera ejecución
Doble clic en `instalar_y_ejecutar.bat` — instala dependencias y hace la primera sync.

Comprobar que `sync_rubi.log` muestra `Sincronización completada OK`.

### 5. Tarea programada (cada 95 minutos)
Abrir **Programador de tareas** de Windows:
1. Crear tarea básica → nombre: `SicAir Sync Rubí`
2. Desencadenador: Diariamente, repetir cada **95 minutos**
3. Acción: Iniciar programa → `ejecutar_sync.bat`
4. Marcar: "Ejecutar tanto si el usuario inició sesión como si no"

## GitHub Pages

El dashboard está publicado en:  
**https://sensaratech.github.io/sicair-rubi/**

Se actualiza automáticamente cada vez que `sync_rubi.py` sube un nuevo `data.json`.

El navegador refresca los datos cada 10 minutos sin recargar la página.

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `index.html` | Entrada de la web |
| `app.jsx` | Dashboard React (SicAir + SicTox) |
| `public/data.json` | Datos exportados desde MySQL (generado por sync) |
| `sync_rubi.py` | Script de sincronización MySQL → GitHub |
| `instalar_y_ejecutar.bat` | Primera instalación |
| `ejecutar_sync.bat` | Ejecución silenciosa para tarea programada |
