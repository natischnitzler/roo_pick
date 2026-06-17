const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

const CLIENTES = [
  'INVERSIONES ROOBOSCH LIMITADA',
  'DISTRIBUIDORA JMMA SPA'
];

// ── XML-RPC usando xmlrpc npm package ──────────────────────────────────────
function callXmlRpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const xmlrpc = require('xmlrpc');
    const isHttps = url.startsWith('https');
    const parsed = new URL(url);
    const client = isHttps
      ? xmlrpc.createSecureClient({ host: parsed.hostname, port: 443, path: parsed.pathname || '/' })
      : xmlrpc.createClient({ host: parsed.hostname, port: 80, path: parsed.pathname || '/' });
    client.methodCall(method, params, (err, val) => {
      if (err) return reject(err);
      resolve(val);
    });
  });
}

async function xmlrpc(service, method, params) {
  return callXmlRpc(`${ODOO_URL}/xmlrpc/2/${service}`, method, params);
}

async function getUid() {
  return await xmlrpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}]);
}

async function callOdoo(uid, model, method, args, kwargs = {}) {
  return await xmlrpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs]);
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const uid = await getUid();
    if (!uid) return res.status(401).json({ error: 'No se pudo autenticar con Odoo' });

    const body = req.body || {};
    const { action } = body;

    // LIST: Picks realizados con pendientes
    if (req.method === 'GET' || action === 'list') {
      const pickIds = await callOdoo(uid, 'stock.picking', 'search', [[
        ['picking_type_id.name', 'ilike', 'Pick'],
        ['state', '=', 'done']
      ]], { order: 'date_done desc', limit: 200 });

      if (!pickIds.length) return res.json({ picks: [] });

      const picks = await callOdoo(uid, 'stock.picking', 'read', [pickIds], {
        fields: ['name', 'partner_id', 'origin', 'state', 'date_done', 'group_id']
      });

      const result = [];
      for (const pick of picks) {
        if (!pick.group_id) continue;
        const partner = pick.partner_id ? pick.partner_id[1] : '';
        const isCliente = CLIENTES.some(c => partner.includes(c.split(' ')[0]));
        if (!isCliente) continue;

        const pendingIds = await callOdoo(uid, 'stock.picking', 'search', [[
          ['group_id', '=', pick.group_id[0]],
          ['state', 'not in', ['done', 'cancel']],
          ['id', '!=', pick.id]
        ]], {});

        if (pendingIds.length > 0) {
          const pending = await callOdoo(uid, 'stock.picking', 'read', [pendingIds], {
            fields: ['name', 'state', 'picking_type_id']
          });
          result.push({ ...pick, pending });
        }
      }

      return res.json({ picks: result });
    }

    // VALIDATE: Validar pendientes de un grupo
    if (action === 'validate') {
      const { groupId } = body;
      if (!groupId) return res.status(400).json({ error: 'groupId requerido' });

      const pendingIds = await callOdoo(uid, 'stock.picking', 'search', [[
        ['group_id', '=', groupId],
        ['state', 'not in', ['done', 'cancel']]
      ]], { order: 'scheduled_date asc' });

      const errors = [];
      for (const rid of pendingIds) {
        try {
          await callOdoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
          await callOdoo(uid, 'stock.picking', 'button_validate', [[rid]], {
            context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
          });
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
          errors.push({ id: rid, error: e.message });
        }
      }

      // Buscar entregas generadas tras validar OUT
      const newPendingIds = await callOdoo(uid, 'stock.picking', 'search', [[
        ['group_id', '=', groupId],
        ['state', 'not in', ['done', 'cancel']]
      ]], { order: 'scheduled_date asc' });

      for (const rid of newPendingIds) {
        try {
          await callOdoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
          await callOdoo(uid, 'stock.picking', 'button_validate', [[rid]], {
            context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
          });
        } catch (e) {
          errors.push({ id: rid, error: e.message });
        }
      }

      return res.json({ ok: true, errors });
    }

    // VALIDATE ALL
    if (action === 'validateAll') {
      const { groupIds } = body;
      if (!groupIds || !groupIds.length) return res.status(400).json({ error: 'groupIds requerido' });

      const results = [];
      for (const groupId of groupIds) {
        try {
          const pendingIds = await callOdoo(uid, 'stock.picking', 'search', [[
            ['group_id', '=', groupId],
            ['state', 'not in', ['done', 'cancel']]
          ]], { order: 'scheduled_date asc' });

          for (const rid of pendingIds) {
            await callOdoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
            await callOdoo(uid, 'stock.picking', 'button_validate', [[rid]], {
              context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
            });
            await new Promise(r => setTimeout(r, 1500));
          }

          const newPendingIds = await callOdoo(uid, 'stock.picking', 'search', [[
            ['group_id', '=', groupId],
            ['state', 'not in', ['done', 'cancel']]
          ]], { order: 'scheduled_date asc' });

          for (const rid of newPendingIds) {
            await callOdoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
            await callOdoo(uid, 'stock.picking', 'button_validate', [[rid]], {
              context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
            });
          }

          results.push({ groupId, ok: true });
        } catch (e) {
          results.push({ groupId, ok: false, error: e.message });
        }
      }
      return res.json({ results });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
