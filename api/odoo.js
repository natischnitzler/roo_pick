const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

const CLIENTES = [
  'INVERSIONES ROOBOSCH LIMITADA',
  'DISTRIBUIDORA JMMA SPA'
];

function buildXmlRpc(method, params) {
  const toXml = (v) => {
    if (v === null || v === undefined) return '<nil/>';
    if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
    if (typeof v === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`;
    if (typeof v === 'string') return `<string>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`;
    if (Array.isArray(v)) return `<array><data>${v.map(i => `<value>${toXml(i)}</value>`).join('')}</data></array>`;
    if (typeof v === 'object') {
      const members = Object.entries(v).map(([k, val]) =>
        `<member><name>${k}</name><value>${toXml(val)}</value></member>`
      ).join('');
      return `<struct>${members}</struct>`;
    }
    return `<string>${v}</string>`;
  };
  return `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${params.map(p => `<param><value>${toXml(p)}</value></param>`).join('')}</params>
</methodCall>`;
}

function parseXmlRpc(txt) {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(txt, 'text/xml');

  const getText = (node) => (node && node.textContent ? node.textContent.trim() : '');

  const getValue = (node) => {
    if (!node) return null;
    // Filter only element children (ignore text nodes)
    const children = node.childNodes ? Array.from(node.childNodes).filter(n => n.nodeType === 1) : [];
    const child = children[0];
    if (!child) return getText(node);
    switch (child.tagName) {
      case 'int': case 'i4': case 'i8': return parseInt(getText(child));
      case 'double': return parseFloat(getText(child));
      case 'boolean': return getText(child) === '1';
      case 'string': return child.textContent || '';
      case 'nil': return null;
      case 'array': {
        const dataNodes = Array.from(child.childNodes).filter(n => n.nodeType === 1 && n.tagName === 'data');
        const data = dataNodes[0];
        if (!data) return [];
        const valueNodes = Array.from(data.childNodes).filter(n => n.nodeType === 1 && n.tagName === 'value');
        return valueNodes.map(getValue);
      }
      case 'struct': {
        const obj = {};
        const memberNodes = Array.from(child.childNodes).filter(n => n.nodeType === 1 && n.tagName === 'member');
        memberNodes.forEach(m => {
          const nameNode = Array.from(m.childNodes).find(n => n.nodeType === 1 && n.tagName === 'name');
          const valNode = Array.from(m.childNodes).find(n => n.nodeType === 1 && n.tagName === 'value');
          if (nameNode && valNode) obj[getText(nameNode)] = getValue(valNode);
        });
        return obj;
      }
    }
    return getText(child);
  };

  const fault = doc.getElementsByTagName('fault')[0];
  if (fault) {
    const faultVal = Array.from(fault.getElementsByTagName('value'))[0];
    const parsed = getValue(faultVal);
    throw new Error(`Odoo fault: ${JSON.stringify(parsed)}`);
  }
  const paramsEl = doc.getElementsByTagName('params')[0];
  const paramEl = paramsEl ? Array.from(paramsEl.getElementsByTagName('param'))[0] : null;
  const valueEl = paramEl ? Array.from(paramEl.getElementsByTagName('value'))[0] : null;
  return getValue(valueEl);
}

async function xmlrpc(service, method, params) {
  const body = buildXmlRpc(method, params);
  const res = await fetch(`${ODOO_URL}/xmlrpc/2/${service}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body
  });
  const txt = await res.text();
  return parseXmlRpc(txt);
}

async function getUid() {
  return await xmlrpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}]);
}

async function callOdoo(uid, model, method, args, kwargs = {}) {
  return await xmlrpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs]);
}

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

    // LIST: Picks realizados con pendientes en el mismo grupo
    if (req.method === 'GET' || action === 'list') {
      // 1. Buscar picks realizados de los clientes
      const pickIds = await callOdoo(uid, 'stock.picking', 'search', [[
        ['picking_type_id.name', 'ilike', 'Pick'],
        ['state', '=', 'done']
      ]], { order: 'date_done desc', limit: 200 });

      if (!pickIds.length) return res.json({ picks: [] });

      const picks = await callOdoo(uid, 'stock.picking', 'read', [pickIds], {
        fields: ['name', 'partner_id', 'origin', 'state', 'date_done', 'group_id']
      });

      // 2. Para cada pick, buscar si hay pendientes en su grupo
      const result = [];
      for (const pick of picks) {
        if (!pick.group_id) continue;
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
