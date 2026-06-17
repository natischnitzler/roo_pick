# Validador de Picks — Odoo

Web app para listar y validar picks de Odoo con un clic.

## Clientes configurados
- INVERSIONES ROOBOSCH LIMITADA
- DISTRIBUIDORA JMMA SPA

---

## Deploy en Vercel

### 1. Sube el proyecto a GitHub
```bash
git init
git add .
git commit -m "inicial"
git remote add origin https://github.com/TU_USUARIO/odoo-picks.git
git push -u origin main
```

### 2. Importa en Vercel
- Ve a https://vercel.com/new
- Conecta tu repositorio GitHub
- En "Framework Preset" selecciona **Other**
- Clic en **Deploy**

### 3. Configura las variables de entorno en Vercel
Ve a tu proyecto → Settings → Environment Variables y agrega:

| Variable | Valor |
|---|---|
| `ODOO_URL` | https://tuempresa.odoo.com |
| `ODOO_DB` | nombre_base_datos |
| `ODOO_USER` | usuario@empresa.com |
| `ODOO_API_KEY` | tu_api_key_de_odoo |

### 4. Genera tu API Key en Odoo
1. En Odoo, haz clic en tu nombre (arriba derecha)
2. Ve a **Preferencias** o **Mi perfil**
3. Pestaña **Seguridad**
4. Clic en **Nueva clave API**
5. Copia la clave y pégala en `ODOO_API_KEY`

### 5. Redeploy
Después de agregar las variables, ve a **Deployments** → clic en los 3 puntos del último deploy → **Redeploy**.

---

## Deploy en Netlify

### Variables de entorno en Netlify
Ve a Site settings → Environment variables y agrega las mismas 4 variables.

La función serverless va en `/api/odoo.js` y Netlify la detecta automáticamente.

---

## Estructura del proyecto
```
odoo-picks/
├── public/
│   └── index.html      ← Frontend
├── api/
│   └── odoo.js         ← Función serverless (proxy a Odoo)
├── package.json
├── vercel.json
└── README.md
```
