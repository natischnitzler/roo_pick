const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_PASS;

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
  const getValue = (node) => {
    if (!node) return null;
    const child = node.children ? node.children[0] : null;
    if (!child) return node.textContent ? node.textContent.trim() : null;

    switch (child.tagName) {
      case 'int': case 'i4': case 'i8': return parseInt(child.textContent);
      case 'double': return parseFloat(child.textContent);
      case 'boolean': return child.textContent.trim() === '1';
      case 'string': return child.textContent;
      case 'nil': return null;
      case 'array': {
        const data = child.querySelector('data');
        return data ? Array.from(data.children).map(getValue) : [];
      }
      case 'struct': {
        const obj = {};
        child.querySelectorAll(':scope > member').forEach(m => {
          const name = m.querySelector('name').textContent;
          const val = m.querySelector('value');
          obj[name] = getValue(val);
        });
        return obj;
      }
    }
    return child.textContent;
  };

  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(txt, 'text/xml');
  const fault = doc.getElementsByTagName('fault')[0];
  if (fault) {
    const faultVal = fault.getElementsByTagName('value')[0];
    const parsed = getValue(faultVal);
    throw new Error(`Odoo fault: ${JSON.stringify(parsed)}`);
  }
  const params = doc.getElementsByTagName('params')[0];
  const param = params ? params.getElementsByTagName('param')[0] : null;
  const value = param ? param.getElementsByTagName('value')[0] : null;
  return getValue(value);
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
  return await xmlrpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
}

async function callOdoo(uid, model, method, args, kwargs = {}) {
  return await xmlrpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const uid = await getUid();
    if (!uid) return res.status(401).json({ error: 'No se pudo autenticar con Odoo' });

    const { action, pickId, groupId } = req.body || {};

    if (req.method === 'GET' || action === 'list') {
      const ids = await callOdoo(uid, 'stock.picking', 'search', [[
        ['picking_type_id.name', 'ilike', 'Pick'],
        ['state', '=', 'assigned'],
        ['partner_id.name', 'in', CLIENTES]
      ]], { order: 'scheduled_date asc', limit: 100 });

      if (!ids.length) return res.json({ picks: [] });

      const picks = await callOdoo(uid, 'stock.picking', 'read', [ids], {
        fields: ['name', 'partner_id', 'origin', 'state', 'scheduled_date', 'group_id', 'move_ids']
      });

      return res.json({ picks });
    }

    if (action === 'validate') {
      if (!pickId) return res.status(400).json({ error: 'pickId requerido' });

      await callOdoo(uid, 'stock.picking', 'button_validate', [[pickId]], {
        context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
      });

      if (groupId) {
        const relIds = await callOdoo(uid, 'stock.picking', 'search', [[
          ['group_id', '=', groupId],
          ['state', 'not in', ['done', 'cancel']],
          ['id', '!=', pickId]
        ]], { order: 'scheduled_date asc' });

        for (const rid of relIds) {
          await callOdoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
          await callOdoo(uid, 'stock.picking', 'button_validate', [[rid]], {
            context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
          });
        }
      }

      return res.json({ ok: true });
    }

    if (action === 'validateAll') {
      const { pickIds } = req.body;
      if (!pickIds || !pickIds.length) return res.status(400).json({ error: 'pickIds requerido' });

      const results = [];
      for (const { id, groupId: gid } of pickIds) {
        try {
          await callOdoo(uid, 'stock.picking', 'button_validate', [[id]], {
            context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
          });

          if (gid) {
            const relIds = await callOdoo(uid, 'stock.picking', 'search', [[
              ['group_id', '=', gid],
              ['state', 'not in', ['done', 'cancel']],
              ['id', '!=', id]
            ]], { order: 'scheduled_date asc' });

            for (const rid of relIds) {
              await callOdoo(uid, 'stock.picking', 'action_assign', [[rid]], {});
              await callOdoo(uid, 'stock.picking', 'button_validate', [[rid]], {
                context: { skip_immediate: true, skip_backorder: true, immediate_transfer: true }
              });
            }
          }
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: e.message });
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
