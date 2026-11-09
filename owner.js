'use strict';

const get = id => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = cents => cents == null ? '—' : usd.format(cents / 100);
const config = window.VHM_OWNER_CONFIG;
let generation = 0;
let exportData = null;

get('date').value = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

function resetReport() {
  exportData = null;
  get('export').disabled = true;
  get('orders').replaceChildren();
  for (const id of ['order-count', 'profit-count', 'gross-total']) get(id).textContent = '—';
  get('status').textContent = '';
  if (get('detail').open) get('detail').close();
}

function showDetail(record) {
  get('detail-title').textContent = `Vrich order #${record.orderId}`;
  const body = get('detail-body');
  body.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = record.reason || `Net merchandise ${money(record.merchandise)} · Landed cost ${money(record.cost)} · Gross profit ${money(record.grossProfit)}`;
  body.append(summary);
  if (record.costLines) {
    const lines = document.createElement('ul');
    for (const line of record.costLines) {
      const row = document.createElement('li');
      row.textContent = `${record.items[line.line].description || record.items[line.line].stockCode} · ${line.sku} · ${line.quantity} × ${money(line.unitCostCents)} · catalog ${line.version}`;
      lines.append(row);
    }
    body.append(lines);
  }
  get('detail').showModal();
}

function showReport(date, records) {
  const verified = records.filter(row => !row.reason);
  const rows = records.map(record => {
    const row = document.createElement('tr');
    const id = row.insertCell();
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `#${record.orderId}`;
    button.onclick = () => showDetail(record);
    id.append(button);
    for (const value of [record.merchandise, record.cost, record.grossProfit]) row.insertCell().textContent = money(value);
    const status = row.insertCell();
    status.className = record.reason ? 'review' : 'profit';
    status.textContent = record.reason || 'Verified';
    return row;
  });
  get('orders').replaceChildren(...rows);
  get('order-count').textContent = records.length;
  get('profit-count').textContent = verified.length;
  get('gross-total').textContent = verified.length ? money(verified.reduce((sum, row) => sum + row.grossProfit, 0)) : '—';
  get('status').textContent = records.length ? `${records.length - verified.length} orders without a verified profit figure.` : 'No orders found on this date.';
  exportData = { schemaVersion: 1, currency: 'USD', orderDate: date, exportedAt: new Date().toISOString(), orders: records };
  get('export').disabled = !records.length;
}

function init() {
  if (!config?.firebase?.apiKey || !config.firebase.projectId || !config.firebase.authDomain || !window.firebase) {
    get('login-status').textContent = 'Setup required. Add the existing Firebase Web configuration.';
    return;
  }
  const app = firebase.initializeApp(config.firebase, 'vhm-owner');
  const auth = app.auth();
  const db = app.firestore();
  let authorized = false;
  const read = async (collection, id) => {
    const doc = await db.collection(collection).doc(id).get({ source: 'server' });
    return doc.exists ? doc.data() : null;
  };

  async function loadOrders() {
    if (!authorized) return;
    const request = ++generation;
    const date = get('date').value;
    resetReport();
    get('status').textContent = 'Loading orders and scan evidence…';
    try {
      const orders = await db.collection('sv2_orders').where('d', '==', date).get({ source: 'server' });
      const ids = orders.docs.map(doc => doc.id);
      const sessions = new Map();
      for (let offset = 0; offset < ids.length; offset += 10) {
        const group = await db.collection('sv2_log').where('order', 'in', ids.slice(offset, offset + 10)).get({ source: 'server' });
        for (const doc of group.docs) {
          const log = doc.data();
          if (!sessions.has(log.order)) sessions.set(log.order, []);
          sessions.get(log.order).push(log);
        }
      }
      const readCost = VHMProfit.catalogReader(read);
      const records = await Promise.all(orders.docs.map(async doc => {
        const order = doc.data();
        const profit = await VHMProfit.calculate(order, sessions.get(doc.id) || [], readCost);
        return { orderId: doc.id, revision: order.rev ?? 1,
          discountCents: order.finance?.discount ?? null, merchandiseBeforeDiscountCents: order.finance?.amount ?? null,
          deliveryFeeCents: order.finance?.deliveryFee ?? null, customerTotalCents: order.finance?.customerTotal ?? null,
          courier: order.ship || null,
          items: (order.items || []).map(item => ({ stockCode: item.stock || item.code, description: item.desc || '', quantity: item.qty, lineAmountCents: item.lineCents ?? null })), ...profit };
      }));
      if (request === generation) showReport(date, records);
    } catch (error) {
      if (request === generation) get('status').textContent = `Could not load the report (${error.code || 'read failed'}). Check Firebase access and try again.`;
    }
  }

  get('filters').onsubmit = event => { event.preventDefault(); loadOrders(); };
  get('date').onchange = () => { generation++; resetReport(); };
  get('sign-in').onclick = async () => {
    get('sign-in').disabled = true;
    get('login-status').textContent = 'Opening Google sign-in…';
    try {
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (error) {
      get('login-status').textContent = `Sign-in failed (${error.code || 'unknown error'}).`;
    } finally { get('sign-in').disabled = false; }
  };
  get('sign-out').onclick = () => auth.signOut();
  auth.onAuthStateChanged(async user => {
    const request = ++generation;
    authorized = false;
    resetReport();
    get('workspace').hidden = true;
    get('login').hidden = false;
    get('sign-out').hidden = !user;
    get('sign-in').disabled = Boolean(user);
    if (!user) { get('login-status').textContent = ''; return; }
    try {
      await read('sv2_profit_owner', 'access');
      if (request !== generation) return;
      authorized = true;
      get('login').hidden = true;
      get('workspace').hidden = false;
      loadOrders();
    } catch (error) {
      if (request === generation) get('login-status').textContent = 'Owner access is unavailable for this account, or the Firebase rules still need to be published.';
    }
  });
}

get('export').onclick = () => {
  if (!exportData) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }));
  link.download = `vhm-owner-${exportData.orderDate}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
};

init();
