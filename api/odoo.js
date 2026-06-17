const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

const CLIENTES = ['INVERSIONES ROOBOSCH LIMITADA', 'DISTRIBUIDORA JMMA SPA'];

function rpc(service, method, params) {
  return new Promise((resolve, reject) => {
    const xmlrpc = require('xmlrpc');
    const parsed = new URL(`${ODOO_URL}/xmlrpc/2/${service}`);
    const client = xmlrpc.createSecureClient({ host: parsed.hostname, port: 443, path: parsed.pathname });
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val));
  });
}

const odoo = (uid, model, method, args, kwargs = {}) =>
  rpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs]);

async function validateGroup(uid, groupId) {
  const find = () => odoo(uid, 'stock.picking', 'search', [[
    ['group_id', '=', groupId],
    ['state', 'not in', ['done', 'cancel']]
  ]], { order: 'scheduled_date asc' });

  for (const rid of await find()) {
    await odoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
    await odoo(uid, 'stock.picking', 'button_validate', [[rid]], {
      context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
    });
    await new Promise(r => setTimeout(r, 1000));
  }
  for (const rid of await find()) {
    await odoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
    await odoo(uid, 'stock.picking', 'button_validate', [[rid]], {
      context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const uid = await rpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}]);
    if (!uid) return res.status(401).json({ error: 'Autenticación fallida' });

    const body = req.body || {};
    const { action } = body;

    if (req.method === 'GET' || action === 'list') {
      const since = new Date();
      since.setDate(since.getDate() - 10);
      const sinceStr = since.toISOString().slice(0, 19).replace('T', ' ');

      const picks = await odoo(uid, 'stock.picking', 'search_read', [[
        ['picking_type_id.name', 'ilike', 'Pick'],
        ['state', '=', 'done'],
        ['partner_id.name', 'in', CLIENTES],
        ['date_done', '>=', sinceStr]
      ]], { fields: ['name', 'partner_id', 'origin', 'date_done', 'group_id'], order: 'date_done desc', limit: 100 });

      if (!picks.length) return res.json({ picks: [] });

      const groupIds = [...new Set(picks.filter(p => p.group_id).map(p => p.group_id[0]))];
      const allPending = await odoo(uid, 'stock.picking', 'search_read', [[
        ['group_id', 'in', groupIds],
        ['state', 'not in', ['done', 'cancel']],
        ['picking_type_id.name', 'not ilike', 'Pick']
      ]], { fields: ['name', 'state', 'group_id', 'picking_type_id'], limit: 500 });

      const byGroup = {};
      for (const p of allPending) {
        if (!p.group_id) continue;
        const gid = p.group_id[0];
        if (!byGroup[gid]) byGroup[gid] = [];
        byGroup[gid].push(p);
      }

      const result = picks
        .filter(p => p.group_id && byGroup[p.group_id[0]]?.length)
        .map(p => ({ ...p, pending: byGroup[p.group_id[0]] }));

      return res.json({ picks: result });
    }

    if (action === 'validate') {
      const { groupId } = body;
      if (!groupId) return res.status(400).json({ error: 'groupId requerido' });
      await validateGroup(uid, groupId);
      return res.json({ ok: true });
    }

    if (action === 'validateAll') {
      const { groupIds } = body;
      if (!groupIds?.length) return res.status(400).json({ error: 'groupIds requerido' });
      const results = [];
      for (const groupId of groupIds) {
        try { await validateGroup(uid, groupId); results.push({ groupId, ok: true }); }
        catch (e) { results.push({ groupId, ok: false, error: e.message }); }
      }
      return res.json({ results });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
