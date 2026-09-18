// cache: 'no-store' evita que el navegador devuelva respuestas viejas
// en celulares/Chrome Android para las consultas a Supabase.
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
  global: {
    fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }),
  },
});

let currentUser = null;
let patientsCache = [];   // [{id, name}]
let currentPatientId = null;
let medsCache = [];       // [{id, patient_id, name, drug, notes}]
let scheduleCache = [];   // [{id, medication_id, time_label, dose_amount, dose_unit, sort_order}]
let stockCache = [];      // [{medication_id, current_quantity, unit, low_stock_days_threshold}]
let doseLogToday = new Set(); // schedule_item_id taken today
let timeGroupsCache = []; // [{id, patient_id, time_label, sort_order}]

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function usernameToEmail(u) {
  return `${u.trim().toLowerCase()}@${window.AUTH_DOMAIN}`;
}

// ---------- AUTH ----------
$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const username = $('#login-username').value;
  const password = $('#login-password').value;
  const { data, error } = await sb.auth.signInWithPassword({
    email: usernameToEmail(username),
    password,
  });
  if (error) {
    $('#login-error').textContent = 'Usuario o contraseña incorrectos.';
    return;
  }
  onLoggedIn(data.user);
});

$('#btn-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  currentUser = null;
  sessionStorage.removeItem('accessLogged');
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
});

async function onLoggedIn(user) {
  currentUser = user;
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  // Se registra una vez por apertura de la app (pestaña/sesión del
  // navegador), aunque la sesión ya estuviera guardada — pero no se
  // duplica si la página se recarga sola (ej. al actualizar versión).
  if (!sessionStorage.getItem('accessLogged')) {
    sessionStorage.setItem('accessLogged', '1');
    sb.from('login_history').insert({ user_id: user.id }).then(() => {});
  }
  await loadPermissionsAndModules();
  await loadAll();
}

// Restaurar sesión si ya estaba logueado
sb.auth.getSession().then(({ data }) => {
  if (data.session) onLoggedIn(data.session.user);
});

// ---------- PERMISOS Y MÓDULOS ----------
let myProfile = null;         // {user_id, display_name, is_admin}
let myPermissions = {};       // {medicamentos:{read,write}, mercaderia:{...}, gastos:{...}}
let allProfiles = [];         // todos los perfiles (para nombres en Gastos/Admin)
let allModulePermissions = []; // permisos de TODOS los usuarios (para filtrar participantes, etc.)
let currentModule = 'medicamentos';

const MODULES = [
  { key: 'medicamentos', label: '💊 Medicamentos' },
  { key: 'mercaderia', label: '🛒 Mercadería' },
  { key: 'gastos', label: '💰 Gastos' },
];

function canRead(mod) { return myProfile?.is_admin || !!myPermissions[mod]?.can_read; }
function canWrite(mod) { return myProfile?.is_admin || !!myPermissions[mod]?.can_write; }

async function loadPermissionsAndModules() {
  const { data: profiles } = await sb.from('app_profiles').select('*');
  allProfiles = profiles || [];
  myProfile = allProfiles.find(p => p.user_id === currentUser.id) || null;

  const { data: perms } = await sb.from('module_permissions').select('*');
  allModulePermissions = perms || [];
  myPermissions = {};
  allModulePermissions.filter(p => p.user_id === currentUser.id).forEach(p => {
    myPermissions[p.module] = { can_read: p.can_read, can_write: p.can_write };
  });

  renderMenu();
}

// Usuarios que tienen (al menos) lectura habilitada en un módulo dado,
// incluyendo siempre a los administradores.
function usersWithModuleAccess(moduleKey) {
  return allProfiles.filter(p =>
    p.is_admin || allModulePermissions.some(mp => mp.user_id === p.user_id && mp.module === moduleKey && mp.can_read)
  );
}

function renderMenu() {
  const list = $('#menu-modules-list');
  list.innerHTML = '';
  const isAdmin = !!myProfile?.is_admin;
  const visible = isAdmin ? [...MODULES] : MODULES.filter(m => canRead(m.key));

  visible.forEach(m => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item' + (m.key === currentModule ? ' active' : '');
    btn.textContent = m.label;
    btn.dataset.key = m.key;
    btn.addEventListener('click', () => { switchModule(m.key); closeMenu(); });
    list.appendChild(btn);
  });
  if (isAdmin) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item' + (currentModule === 'admin' ? ' active' : '');
    btn.textContent = '⚙️ Administración';
    btn.dataset.key = 'admin';
    btn.addEventListener('click', () => { switchModule('admin'); closeMenu(); });
    list.appendChild(btn);
  }

  const allowedKeys = new Set(visible.map(m => m.key));
  if (isAdmin) allowedKeys.add('admin');
  // Nunca elegir un módulo al que este usuario no tiene acceso, y NUNCA
  // caer en "admin" por defecto si no es administrador.
  if (!allowedKeys.has(currentModule)) {
    currentModule = visible[0]?.key || null;
  }

  if (!currentModule) {
    $$('.module-view').forEach(v => v.classList.add('hidden'));
    $('#module-title').textContent = '';
    $('#no-access-msg').classList.remove('hidden');
    return;
  }
  $('#no-access-msg').classList.add('hidden');
  switchModule(currentModule);
}

function toggleMenu() {
  $('#menu-dropdown').classList.toggle('hidden');
}
function closeMenu() {
  $('#menu-dropdown').classList.add('hidden');
}
$('#btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});
document.addEventListener('click', (e) => {
  const wrap = $('.menu-wrap');
  if (wrap && !wrap.contains(e.target)) closeMenu();
});

async function switchModule(key) {
  // Defensa extra: jamás entrar a un módulo sin permiso, aunque se
  // llame directamente a esta función.
  const isAdmin = !!myProfile?.is_admin;
  if (key === 'admin' && !isAdmin) return;
  if (key !== 'admin' && !isAdmin && !canRead(key)) return;

  currentModule = key;
  $$('.module-view').forEach(v => v.classList.add('hidden'));
  $(`#module-${key}`).classList.remove('hidden');
  $$('#menu-modules-list .menu-item').forEach(b => b.classList.toggle('active', b.dataset.key === key));
  const titles = { medicamentos: '💊 Medicamentos', mercaderia: '🛒 Mercadería', gastos: '💰 Gastos', admin: '⚙️ Administración' };
  $('#module-title').textContent = titles[key] || '';
  if (key === 'mercaderia') await loadMercaderia();
  if (key === 'gastos') await loadGastos();
  if (key === 'admin') await loadAdmin();
}

// ---------- MI CUENTA ----------
$('#menu-my-account').addEventListener('click', () => {
  closeMenu();
  $('#account-username').textContent = currentUser.email.replace(`@${window.AUTH_DOMAIN}`, '');
  $('#account-displayname').value = myProfile?.display_name || '';
  $('#account-name-error').textContent = '';
  $('#account-new-password').value = '';
  $('#account-confirm-password').value = '';
  $('#account-password-error').textContent = '';
  $('#modal-account').classList.remove('hidden');
});
$('#btn-close-account').addEventListener('click', () => $('#modal-account').classList.add('hidden'));

$('#btn-save-displayname').addEventListener('click', async () => {
  const name = $('#account-displayname').value.trim();
  $('#account-name-error').textContent = '';
  if (!name) { $('#account-name-error').textContent = 'Ingresá un nombre.'; return; }
  const { error } = await sb.from('app_profiles').update({ display_name: name }).eq('user_id', currentUser.id);
  if (error) { $('#account-name-error').textContent = 'No se pudo guardar: ' + error.message; return; }
  myProfile.display_name = name;
  await loadPermissionsAndModules();
});

$('#btn-change-password').addEventListener('click', async () => {
  const pass = $('#account-new-password').value;
  const confirm = $('#account-confirm-password').value;
  const errEl = $('#account-password-error');
  errEl.textContent = '';
  if (pass.length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
  if (pass !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
  const btn = $('#btn-change-password');
  btn.disabled = true;
  btn.textContent = 'Cambiando...';
  const { error } = await sb.auth.updateUser({ password: pass });
  btn.disabled = false;
  btn.textContent = 'Cambiar contraseña';
  if (error) { errEl.textContent = 'No se pudo cambiar: ' + error.message; return; }
  $('#account-new-password').value = '';
  $('#account-confirm-password').value = '';
  alert('Contraseña actualizada.');
});

$('#btn-logout-everywhere').addEventListener('click', async () => {
  if (!confirm('Esto va a cerrar la sesión en todos los dispositivos donde hayas ingresado. ¿Continuar?')) return;
  await sb.auth.signOut({ scope: 'global' });
  currentUser = null;
  $('#modal-account').classList.add('hidden');
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
});

function profileName(userId) {
  return allProfiles.find(p => p.user_id === userId)?.display_name || '—';
}

// ---------- TABS (genérico, funciona dentro de cualquier módulo) ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn || !btn.dataset.target) return;
  const moduleEl = btn.closest('.module-view');
  if (!moduleEl) return;
  moduleEl.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  moduleEl.querySelectorAll(':scope > .tab-content').forEach(c => c.classList.add('hidden'));
  const target = document.getElementById(btn.dataset.target);
  if (target) target.classList.remove('hidden');
});

// ---------- DATA LOADING ----------
async function loadAll() {
  const { data: patients } = await sb.from('patients').select('*').order('created_at');
  patientsCache = patients || [];

  if (patientsCache.length === 0) {
    // No debería pasar, pero por las dudas creamos una por defecto
    const { data } = await sb.from('patients').insert({ name: 'Familiar 1' }).select().single();
    if (data) patientsCache = [data];
  }
  if (!currentPatientId || !patientsCache.find(p => p.id === currentPatientId)) {
    currentPatientId = patientsCache[0].id;
  }
  renderPatientSelect();

  const [{ data: meds }, { data: sched }, { data: stock }, { data: logs }] = await Promise.all([
    sb.from('medications').select('*').eq('patient_id', currentPatientId).order('created_at'),
    sb.from('schedule_items').select('*').order('sort_order'),
    sb.from('stock').select('*'),
    sb.from('dose_log').select('schedule_item_id, taken_date').eq('taken_date', todayStr()).eq('status', 'taken'),
  ]);
  medsCache = meds || [];
  const medIds = new Set(medsCache.map(m => m.id));
  scheduleCache = (sched || []).filter(si => medIds.has(si.medication_id));
  stockCache = (stock || []).filter(s => medIds.has(s.medication_id));
  doseLogToday = new Set((logs || []).map(l => l.schedule_item_id));

  await syncTimeGroups();

  renderItinerario();
  renderStock();
  renderMedManage();
  renderAlerts();
}

function renderPatientSelect() {
  const container = $('#patient-buttons');
  container.innerHTML = '';
  patientsCache.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'patient-btn' + (p.id === currentPatientId ? ' active' : '');
    btn.textContent = p.name;
    btn.addEventListener('click', async () => {
      if (currentPatientId === p.id) return;
      currentPatientId = p.id;
      await loadAll();
    });
    container.appendChild(btn);
  });
}

// ---------- GESTIÓN DE PERSONAS ----------
$('#btn-manage-patients').addEventListener('click', () => {
  renderPatientsModal();
  $('#modal-patients').classList.remove('hidden');
});
$('#btn-close-patients').addEventListener('click', () => {
  $('#modal-patients').classList.add('hidden');
});

function renderPatientsModal() {
  const list = $('#patients-list');
  list.innerHTML = '';
  patientsCache.forEach(p => {
    const row = document.createElement('div');
    row.className = 'patient-row';
    row.innerHTML = `
      <span class="name">${escapeHtml(p.name)}</span>
      <button type="button" class="btn-remove-row" data-id="${p.id}" title="Eliminar">✕</button>
    `;
    row.querySelector('.btn-remove-row').addEventListener('click', () => deletePatient(p.id, p.name));
    list.appendChild(row);
  });
}

async function deletePatient(id, name) {
  if (patientsCache.length <= 1) {
    alert('Tiene que quedar al menos una persona.');
    return;
  }
  if (!confirm(`¿Eliminar a "${name}" y todos sus medicamentos, horarios y stock?`)) return;
  await sb.from('patients').delete().eq('id', id);
  if (currentPatientId === id) currentPatientId = null;
  renderPatientsModal();
  await loadAll();
}

$('#form-add-patient').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#new-patient-name');
  const name = input.value.trim();
  if (!name) return;
  const { data } = await sb.from('patients').insert({ name }).select().single();
  input.value = '';
  if (data) currentPatientId = data.id;
  renderPatientsModal();
  await loadAll();
});

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function syncTimeGroups() {
  const { data } = await sb.from('time_groups').select('*').eq('patient_id', currentPatientId).order('sort_order');
  timeGroupsCache = data || [];

  const labelsInUse = [...new Set(scheduleCache.map(si => si.time_label))];
  const known = new Set(timeGroupsCache.map(g => g.time_label));
  const missing = labelsInUse.filter(l => !known.has(l));
  if (missing.length > 0) {
    let nextOrder = timeGroupsCache.length > 0 ? Math.max(...timeGroupsCache.map(g => g.sort_order)) + 1 : 0;
    const toInsert = missing.map(label => ({ patient_id: currentPatientId, time_label: label, sort_order: nextOrder++ }));
    const { data: inserted } = await sb.from('time_groups').insert(toInsert).select();
    timeGroupsCache = [...timeGroupsCache, ...(inserted || [])];
  }
}

function orderedTimeLabels() {
  const labelsInUse = new Set(scheduleCache.map(si => si.time_label));
  return timeGroupsCache
    .filter(g => labelsInUse.has(g.time_label))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(g => g.time_label);
}

// ---------- REORDENAR TARJETAS (subir / bajar) ----------
// Un drag continuo resultaba inestable en navegadores móviles (temblor,
// tarjetas mal ubicadas). En su lugar, botones ▲▼ que mueven la tarjeta
// una posición: simple, inmediato y sin sorpresas.
async function moveTimeGroup(label, direction) {
  const order = orderedTimeLabels();
  const idx = order.indexOf(label);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= order.length) return;
  [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];

  order.forEach((lbl, i) => {
    const g = timeGroupsCache.find(tg => tg.time_label === lbl);
    if (g) g.sort_order = i;
  });
  renderItinerario();

  const g1 = timeGroupsCache.find(tg => tg.time_label === label);
  const g2 = timeGroupsCache.find(tg => tg.time_label === order[idx]);
  if (g1) await sb.from('time_groups').update({ sort_order: g1.sort_order }).eq('id', g1.id);
  if (g2 && g2 !== g1) await sb.from('time_groups').update({ sort_order: g2.sort_order }).eq('id', g2.id);
}

// ---------- ITINERARIO ----------
function renderItinerario() {
  const container = $('#itinerario-list');
  container.innerHTML = '';
  if (medsCache.length === 0) {
    container.innerHTML = '<p style="color:#6b7280">Todavía no cargaste medicamentos. Andá a la pestaña "Medicamentos" para agregar el primero.</p>';
    return;
  }
  // Agrupar schedule_items por time_label, usando el orden guardado
  // por el usuario (arrastrando tarjetas), no el orden de carga.
  const groups = {};
  scheduleCache.forEach(si => {
    if (!groups[si.time_label]) groups[si.time_label] = [];
    groups[si.time_label].push(si);
  });
  const order = orderedTimeLabels();
  order.forEach((label, idx) => {
    const items = groups[label];
    const div = document.createElement('div');
    div.className = 'time-group';
    div.dataset.label = label;
    const header = document.createElement('div');
    header.className = 'time-group-header';
    header.innerHTML = `
      <span>${escapeHtml(label)}</span>
      <span class="reorder-btns">
        <button type="button" class="btn-move" data-label="${escapeHtml(label)}" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn-move" data-label="${escapeHtml(label)}" data-dir="1" ${idx === order.length - 1 ? 'disabled' : ''}>▼</button>
      </span>
    `;
    div.appendChild(header);
    items.forEach(si => {
      const med = medsCache.find(m => m.id === si.medication_id);
      if (!med) return;
      const row = document.createElement('div');
      row.className = 'dose-row';
      const checked = doseLogToday.has(si.id);
      row.innerHTML = `
        ${med.pill_photo_url ? `<img class="dose-thumb" src="${med.pill_photo_url}" alt="${escapeHtml(med.name)}" />` : ''}
        <div class="dose-info">
          <div class="dose-name">${escapeHtml(med.name)}</div>
          ${med.drug ? `<div class="dose-sub">(${escapeHtml(med.drug)})</div>` : ''}
          <div class="dose-amount">${si.dose_amount} ${escapeHtml(si.dose_unit)}${med.notes ? ' — ' + escapeHtml(med.notes) : ''}</div>
        </div>
        <button class="check-btn ${checked ? 'checked' : ''}" data-si="${si.id}">${checked ? '✓' : ''}</button>
      `;
      div.appendChild(row);
    });
    container.appendChild(div);
  });

  container.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleDose(btn.dataset.si, btn));
  });
  container.querySelectorAll('.btn-move').forEach(btn => {
    btn.addEventListener('click', () => moveTimeGroup(btn.dataset.label, Number(btn.dataset.dir)));
  });
}

async function toggleDose(scheduleItemId, btn) {
  // El itinerario es de referencia: marcar/desmarcar una toma queda
  // registrado como historial, pero NO afecta el stock. El stock se
  // descuenta solo, día a día, a partir de la fecha en que se cargó.
  const isChecked = doseLogToday.has(scheduleItemId);
  if (isChecked) {
    await sb.from('dose_log').delete()
      .eq('schedule_item_id', scheduleItemId)
      .eq('taken_date', todayStr());
    doseLogToday.delete(scheduleItemId);
    btn.classList.remove('checked');
    btn.textContent = '';
  } else {
    await sb.from('dose_log').insert({
      schedule_item_id: scheduleItemId,
      taken_date: todayStr(),
      status: 'taken',
    });
    doseLogToday.add(scheduleItemId);
    btn.classList.add('checked');
    btn.textContent = '✓';
  }
}

// ---------- STOCK ----------
// El stock se carga como "cantidad a la fecha X" (stock.updated_at).
// A partir de ahí se descuenta automáticamente 1 día de consumo por
// cada día calendario que pasa, asumiendo que el itinerario se cumple
// tal cual está cargado (no depende de los checks del itinerario).
function dailyDoseFor(medId) {
  return scheduleCache
    .filter(si => si.medication_id === medId)
    .reduce((sum, si) => sum + Number(si.dose_amount), 0);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}

// Fecha fija en la que el stock llega a 0, calculada desde la fecha
// en que se cargó el stock (no cambia salvo que se edite el stock).
function zeroDateFor(medId) {
  const s = stockCache.find(x => x.medication_id === medId);
  const daily = dailyDoseFor(medId);
  if (!s || daily <= 0) return null;
  const loadedDate = startOfDay(new Date(s.updated_at));
  const totalDaysSupply = Math.floor(Number(s.current_quantity) / daily);
  const zero = new Date(loadedDate);
  zero.setDate(zero.getDate() + totalDaysSupply);
  return zero;
}

// Días que quedan HOY (puede ser negativo si ya se pasó la fecha)
function daysRemainingFor(medId) {
  const zero = zeroDateFor(medId);
  if (zero === null) return null;
  return daysBetween(new Date(), zero);
}

// Cantidad de comprimidos que quedarían hoy, descontando los días
// transcurridos desde que se cargó el stock.
function effectiveQuantityFor(medId) {
  const s = stockCache.find(x => x.medication_id === medId);
  const daily = dailyDoseFor(medId);
  if (!s) return null;
  if (daily <= 0) return Number(s.current_quantity);
  const loadedDate = startOfDay(new Date(s.updated_at));
  const elapsed = Math.max(0, daysBetween(loadedDate, new Date()));
  return Math.max(0, Number(s.current_quantity) - daily * elapsed);
}

function renderStock() {
  const container = $('#stock-list');
  container.innerHTML = '';
  medsCache.forEach(med => {
    const s = stockCache.find(x => x.medication_id === med.id) || { current_quantity: 0, unit: 'comprimidos', low_stock_days_threshold: 7 };
    const daily = dailyDoseFor(med.id);
    const days = daysRemainingFor(med.id);
    const zeroDate = zeroDateFor(med.id);
    const effectiveQty = effectiveQuantityFor(med.id);
    const isLow = days !== null && days <= Number(s.low_stock_days_threshold);
    const card = document.createElement('div');
    card.className = 'stock-card' + (isLow ? ' low' : '');
    card.innerHTML = `
      <div class="stock-card-top">
        ${med.box_photo_url ? `<img class="stock-thumb" src="${med.box_photo_url}" alt="${escapeHtml(med.name)}" />` : ''}
        <div>
          <div class="name">${escapeHtml(med.name)}${med.drug ? ` <span style="color:#6b7280;font-weight:400">(${escapeHtml(med.drug)})</span>` : ''}</div>
          <div class="meta">Quedan hoy: ${effectiveQty !== null ? effectiveQty : s.current_quantity} ${escapeHtml(s.unit)} · Consumo: ${daily}/día</div>
          ${zeroDate ? `<div class="zero-date">${isLow ? '⚠️ ' : ''}Se agota: ${formatDate(zeroDate)} (${days} días)</div>` : `<div class="meta">Sin horarios cargados</div>`}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// ---------- CALENDARIO DE STOCK ----------
let calendarMonth = startOfDay(new Date());
calendarMonth.setDate(1);

function renderStockCalendar() {
  const container = $('#stock-calendar');
  container.innerHTML = '';

  const monthLabel = calendarMonth.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  const nav = document.createElement('div');
  nav.className = 'calendar-nav';
  nav.innerHTML = `
    <button type="button" id="cal-prev" class="btn-icon-small">‹</button>
    <div class="calendar-month-label">${capitalize(monthLabel)}</div>
    <button type="button" id="cal-next" class="btn-icon-small">›</button>
  `;
  container.appendChild(nav);

  // Mapa día -> [nombres de medicamentos que se agotan ese día]
  const zeroByDay = {};
  medsCache.forEach(med => {
    const zd = zeroDateFor(med.id);
    if (!zd) return;
    const key = zd.toDateString();
    if (!zeroByDay[key]) zeroByDay[key] = [];
    zeroByDay[key].push(med.name);
  });

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  ['Do','Lu','Ma','Mi','Ju','Vi','Sa'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'calendar-dow';
    h.textContent = d;
    grid.appendChild(h);
  });

  const firstDay = new Date(calendarMonth);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const today = startOfDay(new Date());

  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-cell empty';
    grid.appendChild(empty);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
    const key = cellDate.toDateString();
    const meds = zeroByDay[key] || [];
    const cell = document.createElement('div');
    cell.className = 'calendar-cell' + (meds.length ? ' has-event' : '') + (cellDate.getTime() === today.getTime() ? ' is-today' : '');
    cell.title = meds.join(', ');
    cell.innerHTML = `
      <div class="cal-daynum">${day}</div>
      ${meds.length ? `<div class="cal-dot" title="${escapeHtml(meds.join(', '))}">${meds.length}</div>` : ''}
    `;
    grid.appendChild(cell);
  }
  container.appendChild(grid);

  // Lista de medicamentos con vencimiento en el mes visible
  const monthEvents = Object.entries(zeroByDay)
    .map(([key, names]) => ({ date: new Date(key), names }))
    .filter(e => e.date.getFullYear() === calendarMonth.getFullYear() && e.date.getMonth() === calendarMonth.getMonth())
    .sort((a, b) => a.date - b.date);

  const list = document.createElement('div');
  list.className = 'calendar-events-list';
  if (monthEvents.length === 0) {
    list.innerHTML = '<p class="meta">Ningún medicamento se agota este mes.</p>';
  } else {
    monthEvents.forEach(ev => {
      const row = document.createElement('div');
      row.className = 'calendar-event-row';
      row.innerHTML = `<strong>${formatDate(ev.date)}</strong> — ${ev.names.map(escapeHtml).join(', ')}`;
      list.appendChild(row);
    });
  }
  container.appendChild(list);

  $('#cal-prev').addEventListener('click', () => {
    calendarMonth.setMonth(calendarMonth.getMonth() - 1);
    renderStockCalendar();
  });
  $('#cal-next').addEventListener('click', () => {
    calendarMonth.setMonth(calendarMonth.getMonth() + 1);
    renderStockCalendar();
  });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

$('#stock-view-list').addEventListener('click', () => {
  $('#stock-view-list').classList.add('active');
  $('#stock-view-calendar').classList.remove('active');
  $('#stock-list').classList.remove('hidden');
  $('#stock-calendar').classList.add('hidden');
});
$('#stock-view-calendar').addEventListener('click', () => {
  $('#stock-view-calendar').classList.add('active');
  $('#stock-view-list').classList.remove('active');
  $('#stock-calendar').classList.remove('hidden');
  $('#stock-list').classList.add('hidden');
  renderStockCalendar();
});

function renderAlerts() {
  const banner = $('#alerts-banner');
  const low = medsCache.filter(med => {
    const days = daysRemainingFor(med.id);
    const s = stockCache.find(x => x.medication_id === med.id);
    const threshold = s ? Number(s.low_stock_days_threshold) : 7;
    return days !== null && days <= threshold;
  });
  if (low.length === 0) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.textContent = `⚠️ Stock bajo: ${low.map(m => m.name).join(', ')}`;
}

function formatDate(d) {
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ---------- GESTIÓN MEDICAMENTOS ----------
function renderMedManage() {
  const container = $('#med-manage-list');
  container.innerHTML = '';
  medsCache.forEach(med => {
    const items = scheduleCache.filter(si => si.medication_id === med.id);
    const card = document.createElement('div');
    card.className = 'med-manage-card';
    card.innerHTML = `
      <div>
        <div class="name">${escapeHtml(med.name)}</div>
        <div class="sub">${items.length} horario(s) cargado(s)</div>
      </div>
      <div class="chevron">›</div>
    `;
    card.addEventListener('click', () => openMedModal(med.id));
    container.appendChild(card);
  });
}

$('#btn-add-med').addEventListener('click', () => openMedModal(null));
$('#btn-cancel-med').addEventListener('click', closeMedModal);

function closeMedModal() {
  $('#modal-med').classList.add('hidden');
}

function openMedModal(medId) {
  $('#form-med').reset();
  $('#schedule-items-editor').innerHTML = '';
  $('#btn-delete-med').classList.add('hidden');
  // Por si quedó trabado de un guardado anterior
  const saveBtn = $('#form-med').querySelector('button[type=submit]');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Guardar';
  $('#med-patient').innerHTML = patientsCache.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)}</option>`
  ).join('');
  resetPhotoInput('box');
  resetPhotoInput('pill');

  if (medId) {
    const med = medsCache.find(m => m.id === medId);
    const s = stockCache.find(x => x.medication_id === medId) || { current_quantity: 0, low_stock_days_threshold: 7 };
    $('#modal-med-title').textContent = 'Editar medicamento';
    $('#med-id').value = med.id;
    $('#med-patient').value = med.patient_id;
    $('#med-name').value = med.name;
    $('#med-drug').value = med.drug || '';
    $('#med-notes').value = med.notes || '';
    const effQty = effectiveQuantityFor(med.id);
    $('#med-stock').value = effQty !== null ? effQty : s.current_quantity;
    $('#med-threshold').value = s.low_stock_days_threshold;
    $('#btn-delete-med').classList.remove('hidden');
    const items = scheduleCache.filter(si => si.medication_id === medId);
    items.forEach(si => addScheduleRow(si));
    if (med.box_photo_url) {
      $('#med-box-photo-url').value = med.box_photo_url;
      $('#box-photo-preview').src = med.box_photo_url;
      $('#box-photo-preview').classList.remove('hidden');
    }
    if (med.pill_photo_url) {
      $('#med-pill-photo-url').value = med.pill_photo_url;
      $('#pill-photo-preview').src = med.pill_photo_url;
      $('#pill-photo-preview').classList.remove('hidden');
    }
  } else {
    $('#modal-med-title').textContent = 'Nuevo medicamento';
    $('#med-id').value = '';
    $('#med-patient').value = currentPatientId;
    $('#med-stock').value = 0;
    $('#med-threshold').value = 7;
    addScheduleRow();
  }
  $('#modal-med').classList.remove('hidden');
}

function resetPhotoInput(kind) {
  $(`#med-${kind}-photo`).value = '';
  $(`#med-${kind}-photo-url`).value = '';
  $(`#${kind}-photo-preview`).src = '';
  $(`#${kind}-photo-preview`).classList.add('hidden');
}

['box', 'pill'].forEach(kind => {
  $(`#med-${kind}-photo`).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = $(`#${kind}-photo-preview`);
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
  });
});

// Reduce el tamaño de la foto antes de subirla (las fotos de celular
// pesan varios MB y tardan mucho en subir con datos móviles).
function compressImage(file, maxSize = 900, quality = 0.75) {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxSize) {
        height = Math.round(height * (maxSize / width));
        width = maxSize;
      } else if (height > maxSize) {
        width = Math.round(width * (maxSize / height));
        height = maxSize;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', quality);
    };
    img.onerror = () => resolve(file);
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

async function uploadPhotoIfNeeded(kind, medicationId) {
  const fileInput = $(`#med-${kind}-photo`);
  const file = fileInput.files[0];
  if (!file) {
    return $(`#med-${kind}-photo-url`).value || null;
  }
  const compressed = await compressImage(file);
  const path = `${medicationId}/${kind}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from('medication-photos').upload(path, compressed, {
    upsert: true,
    contentType: 'image/jpeg',
  });
  if (error) {
    alert(`No se pudo subir la foto de ${kind === 'box' ? 'la caja' : 'la pastilla'}: ` + error.message);
    return $(`#med-${kind}-photo-url`).value || null;
  }
  const { data } = sb.storage.from('medication-photos').getPublicUrl(path);
  return data.publicUrl;
}

function addScheduleRow(si) {
  const tpl = $('#tpl-schedule-row').content.cloneNode(true);
  const row = tpl.querySelector('.schedule-row');
  if (si) {
    row.dataset.id = si.id;
    row.querySelector('.si-label').value = si.time_label;
    row.querySelector('.si-dose').value = si.dose_amount;
    row.querySelector('.si-unit').value = si.dose_unit;
  }
  row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
  $('#schedule-items-editor').appendChild(row);
}

$('#btn-add-schedule-item').addEventListener('click', () => addScheduleRow());

$('#form-med').addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = $('#form-med').querySelector('button[type=submit]');
  const originalBtnText = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

  try {
    const medId = $('#med-id').value || null;
    const patientId = $('#med-patient').value;
    const name = $('#med-name').value.trim();
    const drug = $('#med-drug').value.trim();
    const notes = $('#med-notes').value.trim();
    const stockQty = Number($('#med-stock').value);
    const threshold = Number($('#med-threshold').value);

    let savedMedId = medId;
    if (medId) {
      const { error } = await sb.from('medications').update({ name, drug, notes, patient_id: patientId }).eq('id', medId);
      if (error) throw new Error('Al actualizar el medicamento: ' + error.message);
    } else {
      const { data, error } = await sb.from('medications')
        .insert({ user_id: currentUser.id, patient_id: patientId, name, drug, notes })
        .select().single();
      if (error) throw new Error('Al crear el medicamento: ' + error.message);
      savedMedId = data.id;
    }

    // Subir fotos (si se eligió alguna) y guardar las URLs en el medicamento
    const boxPhotoUrl = await uploadPhotoIfNeeded('box', savedMedId);
    const pillPhotoUrl = await uploadPhotoIfNeeded('pill', savedMedId);
    const { error: photoErr } = await sb.from('medications').update({
      box_photo_url: boxPhotoUrl,
      pill_photo_url: pillPhotoUrl,
    }).eq('id', savedMedId);
    if (photoErr) throw new Error('Al guardar las fotos: ' + photoErr.message);

    // updated_at = "fecha en que se cargó este stock": a partir de acá
    // se descuenta un día de consumo por cada día calendario que pase.
    const { error: stockErr } = await sb.from('stock').upsert({
      medication_id: savedMedId,
      current_quantity: stockQty,
      low_stock_days_threshold: threshold,
      updated_at: new Date().toISOString(),
    });
    if (stockErr) throw new Error('Al guardar el stock: ' + stockErr.message);

    // Horarios: borrar los que ya no están, upsert el resto
    const rows = [...$('#schedule-items-editor').querySelectorAll('.schedule-row')];
    const existingIds = rows.map(r => r.dataset.id).filter(Boolean);
    const prevItems = scheduleCache.filter(si => si.medication_id === savedMedId);
    const toDelete = prevItems.filter(si => !existingIds.includes(si.id));
    for (const del of toDelete) {
      await sb.from('schedule_items').delete().eq('id', del.id);
    }
    let sortOrder = 0;
    for (const row of rows) {
      const label = row.querySelector('.si-label').value.trim();
      const dose = Number(row.querySelector('.si-dose').value) || 0;
      const unit = row.querySelector('.si-unit').value.trim() || 'comprimidos';
      if (!label) { sortOrder++; continue; }
      if (row.dataset.id) {
        await sb.from('schedule_items').update({
          time_label: label, dose_amount: dose, dose_unit: unit, sort_order: sortOrder,
        }).eq('id', row.dataset.id);
      } else {
        await sb.from('schedule_items').insert({
          medication_id: savedMedId, time_label: label, dose_amount: dose, dose_unit: unit, sort_order: sortOrder,
        });
      }
      sortOrder++;
    }

    closeMedModal();
    await loadAll();
  } catch (err) {
    console.error(err);
    alert('No se pudo guardar: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalBtnText;
  }
});

$('#btn-delete-med').addEventListener('click', async () => {
  const medId = $('#med-id').value;
  if (!medId) return;
  if (!confirm('¿Eliminar este medicamento y todo su historial?')) return;
  await sb.from('medications').delete().eq('id', medId);
  closeMedModal();
  await loadAll();
});

// ---------- LIGHTBOX (ampliar fotos) ----------
document.addEventListener('click', (e) => {
  if (e.target.matches('.dose-thumb, .stock-thumb')) {
    $('#lightbox-img').src = e.target.src;
    $('#modal-lightbox').classList.remove('hidden');
  }
});
$('#modal-lightbox').addEventListener('click', () => {
  $('#modal-lightbox').classList.add('hidden');
  $('#lightbox-img').src = '';
});

// ===================== MÓDULO MERCADERÍA =====================
let shoppingItemsCache = [];
let pantryCache = [];
let shoppingHistoryCache = [];

async function loadMercaderia() {
  const [{ data: items }, { data: pantry }, { data: history }] = await Promise.all([
    sb.from('shopping_items').select('*').order('created_at', { ascending: false }),
    sb.from('pantry_stock').select('*').order('name'),
    sb.from('shopping_movements').select('*').order('created_at', { ascending: false }).limit(100),
  ]);
  shoppingItemsCache = items || [];
  pantryCache = pantry || [];
  shoppingHistoryCache = history || [];
  renderLowStockBanner();
  renderShoppingList();
  renderPantry();
  renderShoppingHistory();
  renderQuickAdd();
  const writeOk = canWrite('mercaderia');
  $('#form-add-shopping-item').classList.toggle('hidden', !writeOk);
  $('#quickadd-section').classList.toggle('hidden', !writeOk);
  $('#btn-add-pantry-item').classList.toggle('hidden', !writeOk);
  $('#btn-clear-shopping-history').classList.toggle('hidden', !myProfile?.is_admin);
}

$('#btn-clear-shopping-history').addEventListener('click', async () => {
  if (!confirm('Esto borra el REGISTRO de movimientos (el log). No afecta tu stock ni tu lista actual, que son independientes. ¿Continuar?')) return;
  await sb.from('shopping_movements').delete().not('id', 'is', null);
  await loadMercaderia();
});

// ----- Catálogo / iconos -----
const DEFAULT_CATEGORIES = ['Almacén', 'Lácteos', 'Carnes', 'Verdulería', 'Limpieza', 'Bebidas', 'Panificados', 'Otros'];

const CATEGORY_ICONS = {
  'Almacén': '🏪',
  'Lácteos': '🥛',
  'Carnes': '🥩',
  'Verdulería': '🥬',
  'Limpieza': '🧹',
  'Bebidas': '🥤',
  'Panificados': '🍞',
  'Otros': '📦',
};
function iconForCategory(cat) {
  return CATEGORY_ICONS[cat] || '🏷️';
}

const EMOJI_KEYWORDS = [
  [/leche|yogur|queso|manteca|crema/i, '🥛'],
  [/carne|pollo|milanesa|asado|bife|cerdo|pescado/i, '🥩'],
  [/pan|factura|medialuna|tostada/i, '🍞'],
  [/fruta|manzana|banana|naranja|limón|limon/i, '🍎'],
  [/verdura|lechuga|tomate|papa|cebolla|zanahoria/i, '🥬'],
  [/agua|gaseosa|bebida|jugo|vino|cerveza/i, '🥤'],
  [/detergente|lavandina|limpiador|jabón|jabon|escoba/i, '🧹'],
  [/papel|servilleta|rollo/i, '🧻'],
  [/huevo/i, '🥚'],
  [/arroz|fideo|pasta|harina|azúcar|azucar|sal/i, '🍚'],
  [/café|cafe|té|te|yerba/i, '☕'],
  [/galletita|dulce|chocolate|golosina/i, '🍫'],
];
function emojiFor(name) {
  const found = EMOJI_KEYWORDS.find(([re]) => re.test(name));
  return found ? found[1] : '🛒';
}

function findPantryItemByName(name) {
  return pantryCache.find(p => p.name.trim().toLowerCase() === name.trim().toLowerCase());
}

let quickAddCategory = null;

function getKnownCategories() {
  const used = [...new Set(pantryCache.map(p => p.category).filter(Boolean))];
  return [...new Set([...used, ...DEFAULT_CATEGORIES])];
}

// La despensa (catálogo) es la fuente de los "productos frecuentes" —
// no el historial de compras.
function getCatalogProducts(category) {
  let list = pantryCache;
  if (category) list = list.filter(p => (p.category || 'Otros') === category);
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

function renderQuickAdd() {
  $('#category-options').innerHTML = getKnownCategories().map(c => `<option value="${escapeHtml(c)}"></option>`).join('');

  const catContainer = $('#category-quickbtns');
  catContainer.innerHTML = '';
  const categories = getKnownCategories();
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'category-tile' + (quickAddCategory === null ? ' active' : '');
  allBtn.innerHTML = `<span class="category-tile-icon">🔎</span><span class="category-tile-label">Todos</span>`;
  allBtn.addEventListener('click', () => { quickAddCategory = null; renderQuickAdd(); });
  catContainer.appendChild(allBtn);
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-tile' + (quickAddCategory === cat ? ' active' : '');
    btn.innerHTML = `<span class="category-tile-icon">${iconForCategory(cat)}</span><span class="category-tile-label">${escapeHtml(cat)}</span>`;
    btn.addEventListener('click', () => { quickAddCategory = cat; renderQuickAdd(); });
    catContainer.appendChild(btn);
  });

  const productsContainer = $('#frequent-products');
  productsContainer.innerHTML = '';
  const products = getCatalogProducts(quickAddCategory);
  const pendingNames = new Set(shoppingItemsCache.filter(i => i.status === 'pending').map(i => i.name.trim().toLowerCase()));
  if (products.length === 0) {
    productsContainer.innerHTML = '<p class="hint">Todavía no tenés productos en tu despensa. Agregalos desde "Stock despensa" o cargando la lista manualmente — se van a ir sumando solos.</p>';
    return;
  }
  products.forEach(p => {
    const alreadyPending = pendingNames.has(p.name.trim().toLowerCase());
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'product-chip' + (alreadyPending ? ' already-added' : '');
    chip.innerHTML = `<span class="emoji">${emojiFor(p.name)}</span> ${escapeHtml(p.name)}`;
    chip.title = alreadyPending ? 'Ya está en la lista pendiente' : `Agregar 1 ${p.unit}`;
    chip.addEventListener('click', () => quickAddFromPantry(p));
    productsContainer.appendChild(chip);
  });
}

async function quickAddFromPantry(pantryItem) {
  const pendingMatch = shoppingItemsCache.find(i => i.status === 'pending' && i.name.trim().toLowerCase() === pantryItem.name.trim().toLowerCase());
  if (pendingMatch) return; // ya está en la lista, no duplicar
  const { data, error } = await sb.from('shopping_items')
    .insert({
      name: pantryItem.name, quantity: 1, unit: pantryItem.unit,
      category: pantryItem.category || null, created_by: currentUser.id,
      pantry_item_id: pantryItem.id,
    })
    .select().single();
  if (error) { alert('Error al agregar: ' + error.message); return; }
  await sb.from('shopping_movements').insert({
    item_id: data.id, item_name: pantryItem.name, action: 'created', user_id: currentUser.id,
    details: `1 ${pantryItem.unit} (agregado rápido)`,
  });
  await loadMercaderia();
}

// ----- Banner de stock bajo: el corazón de este tipo de apps -----
let lowStockExpanded = false;
const LOW_STOCK_COLLAPSE_AT = 4;

function renderLowStockBanner() {
  const banner = $('#low-stock-banner');
  const pendingNames = new Set(shoppingItemsCache.filter(i => i.status === 'pending').map(i => i.name.trim().toLowerCase()));
  const low = pantryCache.filter(p => Number(p.quantity) <= Number(p.low_stock_threshold));
  if (low.length === 0) {
    banner.classList.add('hidden');
    lowStockExpanded = false;
    return;
  }
  banner.classList.remove('hidden');
  const itemsDiv = $('#low-stock-items');
  itemsDiv.innerHTML = '';

  const showAll = lowStockExpanded || low.length <= LOW_STOCK_COLLAPSE_AT;
  const visibleItems = showAll ? low : low.slice(0, LOW_STOCK_COLLAPSE_AT);

  visibleItems.forEach(p => {
    const inList = pendingNames.has(p.name.trim().toLowerCase());
    const row = document.createElement('div');
    row.className = 'low-stock-row';
    row.innerHTML = `
      <span>${emojiFor(p.name)} ${escapeHtml(p.name)} <span class="shop-meta">(quedan ${p.quantity} ${escapeHtml(p.unit)})</span></span>
      <button type="button" class="btn-quick-add" ${inList ? 'disabled' : ''}>${inList ? 'Ya en la lista' : '+ Agregar'}</button>
    `;
    if (!inList) {
      row.querySelector('.btn-quick-add').addEventListener('click', () => quickAddFromPantry(p));
    }
    itemsDiv.appendChild(row);
  });

  if (low.length > LOW_STOCK_COLLAPSE_AT) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-link-small';
    toggleBtn.style.marginTop = '4px';
    toggleBtn.textContent = showAll ? 'Ver menos' : `Ver todos (${low.length})`;
    toggleBtn.addEventListener('click', () => {
      lowStockExpanded = !lowStockExpanded;
      renderLowStockBanner();
    });
    itemsDiv.appendChild(toggleBtn);
  }
}

function renderShoppingList() {
  const container = $('#shopping-list');
  container.innerHTML = '';
  if (shoppingItemsCache.length === 0) {
    container.innerHTML = '<p class="hint">Todavía no hay nada en la lista.</p>';
    return;
  }
  const pending = shoppingItemsCache.filter(i => i.status === 'pending');
  const bought = shoppingItemsCache.filter(i => i.status === 'bought');

  const byCategory = {};
  pending.forEach(i => {
    const cat = i.category?.trim() || 'Sin categoría';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(i);
  });

  if (pending.length === 0 && bought.length === 0) {
    container.innerHTML = '<p class="hint">Todavía no hay nada en la lista.</p>';
  }

  Object.keys(byCategory).sort().forEach(cat => {
    const h = document.createElement('div');
    h.className = 'category-header';
    h.textContent = cat;
    container.appendChild(h);
    byCategory[cat].forEach(item => container.appendChild(renderShopRow(item)));
  });

  if (bought.length > 0) {
    const h = document.createElement('div');
    h.className = 'category-header bought-header';
    h.innerHTML = `<span>Ya comprado</span>`;
    if (canWrite('mercaderia')) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn-link-small';
      clearBtn.textContent = 'Vaciar';
      clearBtn.addEventListener('click', clearBoughtItems);
      h.appendChild(clearBtn);
    }
    container.appendChild(h);
    bought.forEach(item => container.appendChild(renderShopRow(item)));
  }
}

async function clearBoughtItems() {
  if (!confirm('Esto saca de la lista los productos ya comprados (no toca tu stock ni el historial). ¿Continuar?')) return;
  await sb.from('shopping_items').delete().eq('status', 'bought');
  await loadMercaderia();
}

function renderShopRow(item) {
  const row = document.createElement('div');
  row.className = 'shop-row' + (item.status === 'bought' ? ' bought' : '');
  const writeOk = canWrite('mercaderia');
  row.innerHTML = `
    <button class="shop-check ${item.status === 'bought' ? 'checked' : ''}" data-id="${item.id}" ${writeOk ? '' : 'disabled'}>${item.status === 'bought' ? '✓' : ''}</button>
    <div class="shop-info">
      <div class="shop-name">${emojiFor(item.name)} ${escapeHtml(item.name)}</div>
      <div class="shop-meta">${item.quantity} ${escapeHtml(item.unit)}${item.notes ? ' — ' + escapeHtml(item.notes) : ''}</div>
    </div>
    ${writeOk ? `<button class="btn-x" data-del="${item.id}" title="Eliminar">✕</button>` : ''}
  `;
  row.querySelector('.shop-check').addEventListener('click', () => toggleShoppingItem(item));
  const delBtn = row.querySelector('[data-del]');
  if (delBtn) delBtn.addEventListener('click', () => deleteShoppingItem(item));
  return row;
}

$('#form-add-shopping-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#shop-item-name').value.trim();
  const quantity = Number($('#shop-item-qty').value) || 1;
  const unit = $('#shop-item-unit').value.trim() || 'u';
  let category = $('#shop-item-category').value.trim() || null;
  if (!name) return;

  // Si ya existe un producto con ese nombre en la despensa, se hereda
  // su categoría (si no se especificó una) y queda vinculado.
  const match = findPantryItemByName(name);
  if (match && !category) category = match.category;

  const { data, error } = await sb.from('shopping_items')
    .insert({ name, quantity, unit, category, created_by: currentUser.id, pantry_item_id: match?.id || null })
    .select().single();
  if (error) { alert('Error al agregar: ' + error.message); return; }
  await sb.from('shopping_movements').insert({
    item_id: data.id, item_name: name, action: 'created', user_id: currentUser.id,
    details: `${quantity} ${unit}${category ? ' — ' + category : ''}`,
  });
  $('#form-add-shopping-item').reset();
  $('#shop-item-qty').value = 1;
  $('#shop-item-unit').value = 'u';
  await loadMercaderia();
});

async function toggleShoppingItem(item) {
  const nowBought = item.status !== 'bought';
  await sb.from('shopping_items').update({
    status: nowBought ? 'bought' : 'pending',
    bought_by: nowBought ? currentUser.id : null,
    bought_at: nowBought ? new Date().toISOString() : null,
  }).eq('id', item.id);

  await sb.from('shopping_movements').insert({
    item_id: item.id, item_name: item.name,
    action: nowBought ? 'bought' : 'unbought',
    user_id: currentUser.id,
    details: `${item.quantity} ${item.unit}`,
  });

  if (nowBought) {
    // Sumar al stock de despensa: usa el vínculo si existe, si no
    // busca por nombre, y si tampoco existe crea el producto nuevo.
    const existing = (item.pantry_item_id && pantryCache.find(p => p.id === item.pantry_item_id))
      || findPantryItemByName(item.name);
    if (existing) {
      await sb.from('pantry_stock').update({
        quantity: Number(existing.quantity) + Number(item.quantity),
        category: existing.category || item.category || null,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await sb.from('pantry_stock').insert({
        name: item.name, quantity: item.quantity, unit: item.unit, category: item.category || null,
      });
    }
  }
  await loadMercaderia();
}

async function deleteShoppingItem(item) {
  if (!confirm(`¿Eliminar "${item.name}" de la lista?`)) return;
  await sb.from('shopping_movements').insert({
    item_id: item.id, item_name: item.name, action: 'deleted', user_id: currentUser.id,
  });
  await sb.from('shopping_items').delete().eq('id', item.id);
  await loadMercaderia();
}

function renderPantry() {
  const container = $('#pantry-list');
  container.innerHTML = '';
  if (pantryCache.length === 0) {
    container.innerHTML = '<p class="hint">Sin productos cargados todavía.</p>';
    return;
  }
  const writeOk = canWrite('mercaderia');
  pantryCache.forEach(p => {
    const isLow = Number(p.quantity) <= Number(p.low_stock_threshold);
    const row = document.createElement('div');
    row.className = 'pantry-row-v2' + (isLow ? ' low' : '');
    row.innerHTML = `
      <div class="pantry-row-top">
        <span class="shop-name">${emojiFor(p.name)} ${escapeHtml(p.name)}</span>
        ${writeOk ? `
        <span class="pantry-actions">
          <button type="button" class="btn-icon-xs" data-edit="${p.id}" title="Editar">✎</button>
          <button type="button" class="btn-icon-xs danger" data-del="${p.id}" title="Eliminar">✕</button>
        </span>` : ''}
      </div>
      <div class="pantry-row-bottom">
        <span class="shop-meta">${p.category ? escapeHtml(p.category) + ' · ' : ''}${isLow ? '⚠️ Stock bajo' : 'OK'}</span>
        <span class="pantry-qty-edit">
          <input type="number" step="0.5" min="0" value="${p.quantity}" data-qty="${p.id}" ${writeOk ? '' : 'disabled'} />
          <span class="shop-meta">${escapeHtml(p.unit)}</span>
        </span>
      </div>
    `;
    if (writeOk) {
      row.querySelector('[data-qty]').addEventListener('change', async (e) => {
        await sb.from('pantry_stock').update({ quantity: Number(e.target.value), updated_at: new Date().toISOString() }).eq('id', p.id);
        await loadMercaderia();
      });
      row.querySelector('[data-edit]').addEventListener('click', () => openPantryModal(p.id));
      row.querySelector('[data-del]').addEventListener('click', () => deletePantryItem(p));
    }
    container.appendChild(row);
  });
}

function openPantryModal(pantryId) {
  $('#form-pantry-item').reset();
  $('#btn-delete-pantry-item').classList.add('hidden');
  if (pantryId) {
    const p = pantryCache.find(x => x.id === pantryId);
    $('#modal-pantry-title').textContent = 'Editar producto';
    $('#pantry-qty-label').textContent = 'Cantidad';
    $('#pantry-id').value = p.id;
    $('#pantry-name').value = p.name;
    $('#pantry-category').value = p.category || '';
    $('#pantry-qty').value = p.quantity;
    $('#pantry-unit').value = p.unit;
    $('#pantry-threshold').value = p.low_stock_threshold;
    $('#btn-delete-pantry-item').classList.remove('hidden');
  } else {
    $('#modal-pantry-title').textContent = 'Nuevo producto';
    $('#pantry-qty-label').textContent = 'Cantidad inicial';
    $('#pantry-id').value = '';
    $('#pantry-qty').value = 0;
    $('#pantry-unit').value = 'u';
    $('#pantry-threshold').value = 1;
  }
  $('#modal-pantry-item').classList.remove('hidden');
}

async function deletePantryItem(p) {
  if (!confirm(`¿Eliminar "${p.name}" de la despensa? (Si está en alguna lista de compras, queda como producto suelto, sin vínculo.)`)) return;
  await sb.from('pantry_stock').delete().eq('id', p.id);
  await loadMercaderia();
}

$('#btn-add-pantry-item').addEventListener('click', () => openPantryModal(null));
$('#btn-cancel-pantry-item').addEventListener('click', () => $('#modal-pantry-item').classList.add('hidden'));

$('#btn-delete-pantry-item').addEventListener('click', async () => {
  const id = $('#pantry-id').value;
  if (!id) return;
  const p = pantryCache.find(x => x.id === id);
  if (p) await deletePantryItem(p);
  $('#modal-pantry-item').classList.add('hidden');
});

$('#form-pantry-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#pantry-id').value || null;
  const name = $('#pantry-name').value.trim();
  const category = $('#pantry-category').value.trim() || null;
  const quantity = Number($('#pantry-qty').value) || 0;
  const unit = $('#pantry-unit').value.trim() || 'u';
  const threshold = Number($('#pantry-threshold').value) || 0;
  if (!name) return;

  const duplicate = findPantryItemByName(name);
  if (duplicate && duplicate.id !== id) { alert('Ya existe un producto con ese nombre en la despensa.'); return; }

  if (id) {
    const { error } = await sb.from('pantry_stock').update({
      name, category, quantity, unit, low_stock_threshold: threshold, updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) { alert('Error: ' + error.message); return; }
  } else {
    const { error } = await sb.from('pantry_stock').insert({ name, category, quantity, unit, low_stock_threshold: threshold });
    if (error) { alert('Error: ' + error.message); return; }
  }
  $('#modal-pantry-item').classList.add('hidden');
  await loadMercaderia();
});

function renderShoppingHistory() {
  const container = $('#shopping-history');
  container.innerHTML = '';
  if (shoppingHistoryCache.length === 0) {
    container.innerHTML = '<p class="hint">Sin movimientos todavía.</p>';
    return;
  }
  const actionLabels = { created: 'agregó', bought: 'compró', unbought: 'desmarcó', deleted: 'eliminó', updated: 'editó' };
  shoppingHistoryCache.forEach(h => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const when = new Date(h.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <div><strong>${escapeHtml(profileName(h.user_id))}</strong> ${actionLabels[h.action] || h.action} <strong>${escapeHtml(h.item_name)}</strong>${h.details ? ' — ' + escapeHtml(h.details) : ''}</div>
      <div class="when">${when}</div>
    `;
    container.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ===================== MÓDULO GASTOS =====================
let expensesCache = [];
let expenseSplitsCache = [];
let settlementsCache = [];
let categoriesCache = [];
let accountsCache = [];
let templatesCache = [];

async function loadGastos() {
  const [{ data: exp }, { data: splits }, { data: sett }, { data: cats }, { data: accs }, { data: tpls }] = await Promise.all([
    sb.from('expenses').select('*').order('expense_date', { ascending: false }),
    sb.from('expense_splits').select('*'),
    sb.from('settlements').select('*').order('settled_date', { ascending: false }),
    sb.from('expense_categories').select('*').order('name'),
    sb.from('payment_accounts').select('*').order('owner_name'),
    sb.from('fixed_expense_templates').select('*').eq('active', true).order('name'),
  ]);
  expensesCache = exp || [];
  expenseSplitsCache = splits || [];
  settlementsCache = sett || [];
  categoriesCache = cats || [];
  accountsCache = accs || [];
  templatesCache = tpls || [];

  populateExpenseFilters();
  renderExpenses();
  renderBalances();
  renderExternalBalances();
  renderSettlements();
  renderCategories();
  renderAccounts();
  renderTemplates();

  const writeOk = canWrite('gastos');
  $('#btn-add-expense').classList.toggle('hidden', !writeOk);
  $('#btn-add-settlement').classList.toggle('hidden', !writeOk);
  $('#btn-add-account').classList.toggle('hidden', !writeOk);
  $('#btn-add-template').classList.toggle('hidden', !writeOk);
  $('#form-add-category').classList.toggle('hidden', !writeOk);
  $('#gastos-admin-section').classList.toggle('hidden', !myProfile?.is_admin);
}

$('#btn-clear-expenses').addEventListener('click', async () => {
  if (!confirm('Esto borra TODOS los gastos cargados (y su reparto). Los pagos registrados no se tocan. ¿Continuar?')) return;
  await sb.from('expenses').delete().not('id', 'is', null);
  await loadGastos();
});

$('#btn-clear-settlements').addEventListener('click', async () => {
  if (!confirm('Esto borra TODOS los pagos registrados entre usuarios. ¿Continuar?')) return;
  await sb.from('settlements').delete().not('id', 'is', null);
  await loadGastos();
});

function accountLabel(acc) {
  return `${acc.owner_name} — ${acc.label}`;
}

// ----- Filtros -----
function populateExpenseFilters() {
  const userSel = $('#expense-filter-user');
  const userCurrent = userSel.value;
  userSel.innerHTML = '<option value="">Todos los usuarios</option>' +
    usersWithModuleAccess('gastos').map(p => `<option value="${p.user_id}">${escapeHtml(p.display_name)}</option>`).join('');
  if (userCurrent) userSel.value = userCurrent;

  const accSel = $('#expense-filter-account');
  const accCurrent = accSel.value;
  accSel.innerHTML = '<option value="">Todas las cuentas</option><option value="__compartido__">Compartido entre hermanos</option>' +
    accountsCache.map(a => `<option value="${a.id}">${escapeHtml(accountLabel(a))}</option>`).join('');
  if (accCurrent) accSel.value = accCurrent;

  const catSel = $('#expense-filter-category');
  const catCurrent = catSel.value;
  catSel.innerHTML = '<option value="">Todas las categorías</option>' +
    categoriesCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (catCurrent) catSel.value = catCurrent;
}

function getFilteredExpenses() {
  const userFilter = $('#expense-filter-user').value;
  const accFilter = $('#expense-filter-account').value;
  const catFilter = $('#expense-filter-category').value;
  const fromFilter = $('#expense-filter-from').value;
  const toFilter = $('#expense-filter-to').value;

  return expensesCache.filter(exp => {
    if (userFilter) {
      // Solo por quién pagó (o quién lo cargó, en gastos de cuenta
      // externa) — no por ser uno de los que participa del reparto,
      // porque eso hacía que casi todo apareciera igual.
      if (exp.paid_by !== userFilter && exp.created_by !== userFilter) return false;
    }
    if (accFilter === '__compartido__' && exp.expense_type !== 'compartido') return false;
    if (accFilter && accFilter !== '__compartido__' && exp.payment_account_id !== accFilter) return false;
    if (catFilter && exp.category_id !== catFilter) return false;
    if (fromFilter && exp.expense_date < fromFilter) return false;
    if (toFilter && exp.expense_date > toFilter) return false;
    return true;
  });
}

['expense-filter-user', 'expense-filter-account', 'expense-filter-category', 'expense-filter-from', 'expense-filter-to'].forEach(id => {
  $(`#${id}`).addEventListener('change', renderExpenses);
});
$('#btn-clear-expense-filters').addEventListener('click', () => {
  $('#expense-filter-user').value = '';
  $('#expense-filter-account').value = '';
  $('#expense-filter-category').value = '';
  $('#expense-filter-from').value = '';
  $('#expense-filter-to').value = '';
  renderExpenses();
});
$('#btn-toggle-expense-filters').addEventListener('click', () => {
  $('#expense-filter-bar').classList.toggle('hidden');
});

function updateExpenseFilterCount() {
  const active = [
    $('#expense-filter-user').value, $('#expense-filter-account').value, $('#expense-filter-category').value,
    $('#expense-filter-from').value, $('#expense-filter-to').value,
  ].filter(Boolean).length;
  $('#expense-filter-count').textContent = active > 0 ? `(${active})` : '';
}

function renderExpenses() {
  updateExpenseFilterCount();
  const container = $('#expenses-list');
  container.innerHTML = '';
  const filtered = getFilteredExpenses();
  if (filtered.length === 0) {
    container.innerHTML = '<p class="hint">No hay gastos que coincidan.</p>';
    return;
  }
  const writeOk = canWrite('gastos');
  filtered.forEach(exp => {
    const splits = expenseSplitsCache.filter(s => s.expense_id === exp.id);
    const cat = categoriesCache.find(c => c.id === exp.category_id);
    const account = accountsCache.find(a => a.id === exp.payment_account_id);
    const row = document.createElement('div');
    row.className = 'expense-row';
    let subline;
    if (exp.expense_type === 'cuenta_externa') {
      subline = `${formatDate(new Date(exp.expense_date))} · 💳 ${escapeHtml(account ? accountLabel(account) : 'Cuenta eliminada')}${cat ? ' · ' + escapeHtml(cat.name) : ''}`;
    } else {
      subline = `${formatDate(new Date(exp.expense_date))} · Pagó ${escapeHtml(profileName(exp.paid_by))} · Entre: ${splits.map(s => escapeHtml(profileName(s.user_id))).join(', ')}${cat ? ' · ' + escapeHtml(cat.name) : ''}`;
    }
    if (exp.is_fixed) subline += ' · <span class="fixed-badge">📌 Fijo</span>';
    row.innerHTML = `
      <div class="top-line">
        <span>${escapeHtml(exp.description)}</span>
        <span class="expense-row-right">
          <span>$${Number(exp.amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
          ${writeOk ? `
          <span class="expense-menu-wrap">
            <button type="button" class="btn-dots" data-id="${exp.id}">⋮</button>
            <div class="expense-menu hidden" data-menu-for="${exp.id}">
              <button type="button" class="menu-item" data-action="edit" data-id="${exp.id}">✏️ Editar</button>
              <button type="button" class="menu-item menu-item-danger" data-action="delete" data-id="${exp.id}">🗑️ Eliminar</button>
            </div>
          </span>` : ''}
        </span>
      </div>
      <div class="meta">${subline}</div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.btn-dots').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = container.querySelector(`.expense-menu[data-menu-for="${btn.dataset.id}"]`);
      const wasHidden = menu.classList.contains('hidden');
      container.querySelectorAll('.expense-menu').forEach(m => m.classList.add('hidden'));
      if (wasHidden) menu.classList.remove('hidden');
    });
  });
  container.querySelectorAll('.expense-menu .menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = item.dataset.id;
      if (item.dataset.action === 'edit') {
        openExpenseModal(id);
      } else if (item.dataset.action === 'delete') {
        if (confirm('¿Eliminar este gasto?')) {
          await sb.from('expenses').delete().eq('id', id);
          await loadGastos();
        }
      }
    });
  });
}
document.addEventListener('click', () => {
  $$('.expense-menu').forEach(m => m.classList.add('hidden'));
});

function computeNetBalances() {
  // positivo = a favor; negativo = pendiente
  // Solo entran los gastos "compartidos entre hermanos" — los pagados
  // con cuenta de Papá/Mamá quedan totalmente afuera del balance.
  const net = {};
  usersWithModuleAccess('gastos').forEach(p => { net[p.user_id] = 0; });
  expensesCache.filter(exp => exp.expense_type === 'compartido').forEach(exp => {
    if (exp.paid_by in net) net[exp.paid_by] = (net[exp.paid_by] || 0) + Number(exp.amount);
  });
  const compartidoIds = new Set(expensesCache.filter(exp => exp.expense_type === 'compartido').map(e => e.id));
  expenseSplitsCache.filter(s => compartidoIds.has(s.expense_id)).forEach(s => {
    if (s.user_id in net) net[s.user_id] = (net[s.user_id] || 0) - Number(s.share_amount);
  });
  settlementsCache.forEach(s => {
    if (s.from_user in net) net[s.from_user] = (net[s.from_user] || 0) + Number(s.amount);
    if (s.to_user in net) net[s.to_user] = (net[s.to_user] || 0) - Number(s.amount);
  });
  return net;
}

// Simplifica deudas: quién le paga a quién y cuánto, minimizando transacciones
function simplifyDebts(net) {
  const creditors = [];
  const debtors = [];
  Object.entries(net).forEach(([userId, amount]) => {
    const rounded = Math.round(amount * 100) / 100;
    if (rounded > 0.01) creditors.push({ userId, amount: rounded });
    else if (rounded < -0.01) debtors.push({ userId, amount: -rounded });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);
  const transactions = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    transactions.push({ from: debtors[i].userId, to: creditors[j].userId, amount: Math.round(pay * 100) / 100 });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }
  return transactions;
}

function renderBalances() {
  const net = computeNetBalances();
  const eligible = usersWithModuleAccess('gastos');
  const container = $('#balances-summary');
  container.innerHTML = '<h3 class="section-title">Balance de cada uno</h3><div class="balance-cards-grid"></div>';
  const grid = container.querySelector('.balance-cards-grid');
  eligible.forEach(p => {
    const amount = Math.round((net[p.user_id] || 0) * 100) / 100;
    const isPositive = amount > 0.01;
    const isNegative = amount < -0.01;
    const card = document.createElement('div');
    card.className = 'balance-card-v2' + (isPositive ? ' positive' : isNegative ? ' negative' : ' neutral');
    const status = isPositive ? 'a favor' : isNegative ? 'pendiente' : 'al día';
    const amountText = (isPositive || isNegative) ? `$${Math.abs(amount).toFixed(2)}` : '—';
    const initial = p.display_name.trim().charAt(0).toUpperCase();
    card.innerHTML = `
      <div class="balance-avatar">${escapeHtml(initial)}</div>
      <div class="balance-name">${escapeHtml(p.display_name)}</div>
      <div class="balance-amount">${amountText}</div>
      <div class="balance-status">${status}</div>
    `;
    grid.appendChild(card);
  });

  const debts = simplifyDebts(net);
  const debtsTitle = document.createElement('h3');
  debtsTitle.className = 'section-title';
  debtsTitle.textContent = 'Ajustes sugeridos';
  container.appendChild(debtsTitle);
  if (debts.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Todo equilibrado, sin ajustes pendientes.';
    container.appendChild(p);
  } else {
    debts.forEach(d => {
      const row = document.createElement('div');
      row.className = 'debt-row';
      row.innerHTML = `<strong>${escapeHtml(profileName(d.from))}</strong> → <strong>${escapeHtml(profileName(d.to))}</strong>: <strong>$${d.amount.toFixed(2)}</strong>`;
      container.appendChild(row);
    });
  }
}

function renderExternalBalances() {
  const container = $('#external-balances');
  container.innerHTML = '';
  const totals = {}; // owner_name -> {amount, count}
  expensesCache.filter(exp => exp.expense_type === 'cuenta_externa').forEach(exp => {
    const acc = accountsCache.find(a => a.id === exp.payment_account_id);
    const owner = acc ? acc.owner_name : 'Sin cuenta';
    if (!totals[owner]) totals[owner] = { amount: 0, count: 0 };
    totals[owner].amount += Number(exp.amount);
    totals[owner].count += 1;
  });
  const owners = Object.keys(totals);
  if (owners.length === 0) {
    container.innerHTML = '<p class="hint">Todavía no hay gastos cargados con cuenta de Papá/Mamá.</p>';
    return;
  }
  owners.forEach(owner => {
    const t = totals[owner];
    const card = document.createElement('div');
    card.className = 'external-balance-card';
    card.innerHTML = `
      <div class="external-balance-icon">💳</div>
      <div class="external-balance-owner">${escapeHtml(owner)}</div>
      <div class="external-balance-amount">$${t.amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</div>
      <div class="external-balance-count">${t.count} gasto${t.count === 1 ? '' : 's'}</div>
    `;
    container.appendChild(card);
  });
}

function renderSettlements() {
  const container = $('#settlements-list');
  container.innerHTML = '';
  if (settlementsCache.length === 0) {
    container.innerHTML = '<p class="hint">Sin pagos registrados todavía.</p>';
    return;
  }
  settlementsCache.forEach(s => {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.innerHTML = `
      <div><strong>${escapeHtml(profileName(s.from_user))}</strong> le pagó <strong>$${Number(s.amount).toFixed(2)}</strong> a <strong>${escapeHtml(profileName(s.to_user))}</strong>${s.notes ? ' — ' + escapeHtml(s.notes) : ''}</div>
      <div class="when">${formatDate(new Date(s.settled_date))}</div>
    `;
    container.appendChild(row);
  });
}

// ----- Categorías -----
let editingCategoryId = null;

function renderCategories() {
  const container = $('#categories-list');
  container.innerHTML = '';
  const writeOk = canWrite('gastos');
  if (categoriesCache.length === 0) {
    container.innerHTML = '<p class="hint">Sin categorías todavía.</p>';
    return;
  }
  categoriesCache.forEach(c => {
    const row = document.createElement('div');
    row.className = 'category-row';

    if (editingCategoryId === c.id) {
      row.innerHTML = `
        <input type="text" class="category-edit-input" value="${escapeHtml(c.name)}" />
        <span style="display:flex;gap:4px;">
          <button type="button" class="btn-icon-xs" data-save="${c.id}" title="Guardar">✓</button>
          <button type="button" class="btn-icon-xs" data-cancel-edit title="Cancelar">✕</button>
        </span>
      `;
      const input = row.querySelector('.category-edit-input');
      row.querySelector('[data-save]').addEventListener('click', async () => {
        const newName = input.value.trim();
        if (!newName) return;
        const { error } = await sb.from('expense_categories').update({ name: newName }).eq('id', c.id);
        if (error) { alert('Error: ' + error.message); return; }
        editingCategoryId = null;
        await loadGastos();
      });
      row.querySelector('[data-cancel-edit]').addEventListener('click', () => {
        editingCategoryId = null;
        renderCategories();
      });
    } else {
      row.innerHTML = `
        <span class="label">${escapeHtml(c.name)}</span>
        ${writeOk ? `
        <span style="display:flex;gap:4px;">
          <button type="button" class="btn-icon-xs" data-edit="${c.id}" title="Editar">✎</button>
          <button type="button" class="btn-icon-xs danger" data-del="${c.id}" title="Eliminar">✕</button>
        </span>` : ''}
      `;
      if (writeOk) {
        row.querySelector('[data-edit]').addEventListener('click', () => {
          editingCategoryId = c.id;
          renderCategories();
        });
        row.querySelector('[data-del]').addEventListener('click', async () => {
          if (!confirm(`¿Eliminar la categoría "${c.name}"? Los gastos que la usaban quedan sin categoría.`)) return;
          await sb.from('expense_categories').delete().eq('id', c.id);
          await loadGastos();
        });
      }
    }
    container.appendChild(row);
  });
}

$('#form-add-category').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#new-category-name').value.trim();
  if (!name) return;
  const { error } = await sb.from('expense_categories').insert({ name });
  if (error) { alert('Ya existe esa categoría o hubo un error: ' + error.message); return; }
  $('#new-category-name').value = '';
  await loadGastos();
});

// ----- Cuentas de pago (Papá/Mamá, etc.) -----
function renderAccounts() {
  const container = $('#accounts-list');
  container.innerHTML = '';
  const writeOk = canWrite('gastos');
  if (accountsCache.length === 0) {
    container.innerHTML = '<p class="hint">Sin cuentas cargadas todavía.</p>';
    return;
  }
  accountsCache.forEach(a => {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.innerHTML = `
      <div>
        <div class="label">${escapeHtml(a.label)}</div>
        <div class="owner">${escapeHtml(a.owner_name)}</div>
      </div>
      ${writeOk ? `
      <span style="display:flex;gap:4px;">
        <button type="button" class="btn-icon-xs" data-edit-acc="${a.id}" title="Editar">✎</button>
        <button type="button" class="btn-icon-xs danger" data-del-acc="${a.id}" title="Eliminar">✕</button>
      </span>` : ''}
    `;
    if (writeOk) {
      row.querySelector('[data-edit-acc]').addEventListener('click', () => openPaymentAccountModal(a.id));
      row.querySelector('[data-del-acc]').addEventListener('click', async () => {
        if (!confirm(`¿Eliminar la cuenta "${a.label}" de ${a.owner_name}?`)) return;
        await sb.from('payment_accounts').delete().eq('id', a.id);
        await loadGastos();
      });
    }
    container.appendChild(row);
  });
}

function openPaymentAccountModal(accountId) {
  $('#form-payment-account').reset();
  $('#payment-account-id').value = '';
  $('#btn-delete-payment-account').classList.add('hidden');
  if (accountId) {
    const a = accountsCache.find(x => x.id === accountId);
    $('#modal-payment-account-title').textContent = 'Editar cuenta';
    $('#payment-account-id').value = a.id;
    $('#payment-account-owner-name').value = a.owner_name;
    $('#payment-account-label').value = a.label;
    $('#btn-delete-payment-account').classList.remove('hidden');
  } else {
    $('#modal-payment-account-title').textContent = 'Nueva cuenta';
  }
  $('#modal-payment-account').classList.remove('hidden');
}

$('#btn-add-account').addEventListener('click', () => openPaymentAccountModal(null));
$('#btn-cancel-payment-account').addEventListener('click', () => $('#modal-payment-account').classList.add('hidden'));

$('#form-payment-account').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#payment-account-id').value || null;
  const ownerName = $('#payment-account-owner-name').value.trim();
  const label = $('#payment-account-label').value.trim();
  if (!ownerName || !label) return;
  const { error } = id
    ? await sb.from('payment_accounts').update({ owner_name: ownerName, label }).eq('id', id)
    : await sb.from('payment_accounts').insert({ owner_name: ownerName, label });
  if (error) { alert('Error: ' + error.message); return; }
  $('#modal-payment-account').classList.add('hidden');
  await loadGastos();
});

$('#btn-delete-payment-account').addEventListener('click', async () => {
  const id = $('#payment-account-id').value;
  if (!id) return;
  if (!confirm('¿Eliminar esta cuenta?')) return;
  await sb.from('payment_accounts').delete().eq('id', id);
  $('#modal-payment-account').classList.add('hidden');
  await loadGastos();
});

// ----- Gastos fijos (plantillas reutilizables) -----
function templateAccountLabel(t) {
  const acc = accountsCache.find(a => a.id === t.payment_account_id);
  return acc ? accountLabel(acc) : '—';
}

function renderTemplates() {
  const container = $('#templates-list');
  container.innerHTML = '';
  const writeOk = canWrite('gastos');
  if (templatesCache.length === 0) {
    container.innerHTML = '<p class="hint">Todavía no cargaste ningún gasto fijo.</p>';
    return;
  }
  templatesCache.forEach(t => {
    const cat = categoriesCache.find(c => c.id === t.category_id);
    const row = document.createElement('div');
    row.className = 'category-row';
    const detail = t.expense_type === 'cuenta_externa'
      ? `💳 ${templateAccountLabel(t)}`
      : `Entre: ${(t.default_participants || []).map(uid => profileName(uid)).join(', ') || '—'}`;
    row.innerHTML = `
      <div>
        <div class="label">📌 ${escapeHtml(t.name)}${t.default_amount ? ` — $${Number(t.default_amount).toLocaleString('es-AR')}` : ''}</div>
        <div class="shop-meta">${cat ? escapeHtml(cat.name) + ' · ' : ''}${detail}</div>
      </div>
      ${writeOk ? `
      <span style="display:flex;gap:4px;">
        <button type="button" class="btn-icon-xs" data-edit-tpl="${t.id}" title="Editar">✎</button>
        <button type="button" class="btn-icon-xs danger" data-del-tpl="${t.id}" title="Eliminar">✕</button>
      </span>` : ''}
    `;
    if (writeOk) {
      row.querySelector('[data-edit-tpl]').addEventListener('click', () => openTemplateModal(t.id));
      row.querySelector('[data-del-tpl]').addEventListener('click', async () => {
        if (!confirm(`¿Eliminar el gasto fijo "${t.name}"?`)) return;
        await sb.from('fixed_expense_templates').delete().eq('id', t.id);
        await loadGastos();
      });
    }
    container.appendChild(row);
  });
}

$('#btn-add-template').addEventListener('click', () => openTemplateModal(null));
$('#btn-cancel-template').addEventListener('click', () => $('#modal-template').classList.add('hidden'));

$('#template-type-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented-btn');
  if (!btn) return;
  $$('#template-type-toggle .segmented-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const isExterna = btn.dataset.type === 'cuenta_externa';
  $('#template-compartido-fields').classList.toggle('hidden', isExterna);
  $('#template-cuenta-fields').classList.toggle('hidden', !isExterna);
});

function openTemplateModal(templateId) {
  $('#form-template').reset();
  $('#btn-delete-template').classList.add('hidden');

  $('#template-category').innerHTML = '<option value="">Sin categoría</option>' +
    categoriesCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('#template-account').innerHTML = accountsCache.length
    ? accountsCache.map(a => `<option value="${a.id}">${escapeHtml(accountLabel(a))}</option>`).join('')
    : '<option value="">No hay cuentas cargadas — agregá una en la pestaña "Cuentas"</option>';

  const eligible = usersWithModuleAccess('gastos');
  const t = templateId ? templatesCache.find(x => x.id === templateId) : null;
  const defaultParticipants = t ? (t.default_participants || []) : eligible.map(p => p.user_id);
  const participantsDiv = $('#template-participants');
  participantsDiv.innerHTML = '';
  eligible.forEach(p => {
    const chip = document.createElement('span');
    chip.className = 'participant-chip' + (defaultParticipants.includes(p.user_id) ? ' selected' : '');
    chip.textContent = p.display_name;
    chip.dataset.userId = p.user_id;
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    participantsDiv.appendChild(chip);
  });

  $$('#template-type-toggle .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.type === (t?.expense_type || 'compartido')));
  $('#template-compartido-fields').classList.toggle('hidden', t?.expense_type === 'cuenta_externa');
  $('#template-cuenta-fields').classList.toggle('hidden', t?.expense_type !== 'cuenta_externa');

  if (t) {
    $('#modal-template-title').textContent = 'Editar gasto fijo';
    $('#template-id').value = t.id;
    $('#template-name').value = t.name;
    $('#template-amount').value = t.default_amount || '';
    $('#template-category').value = t.category_id || '';
    if (t.expense_type === 'cuenta_externa') $('#template-account').value = t.payment_account_id || '';
    $('#btn-delete-template').classList.remove('hidden');
  } else {
    $('#modal-template-title').textContent = 'Nuevo gasto fijo';
    $('#template-id').value = '';
  }
  $('#modal-template').classList.remove('hidden');
}

$('#form-template').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#template-id').value || null;
  const name = $('#template-name').value.trim();
  const amount = $('#template-amount').value ? Number($('#template-amount').value) : null;
  const categoryId = $('#template-category').value || null;
  const expenseType = $('#template-type-toggle .segmented-btn.active')?.dataset.type || 'compartido';
  if (!name) return;

  const payload = { name, default_amount: amount, category_id: categoryId, expense_type: expenseType };
  if (expenseType === 'cuenta_externa') {
    const accountId = $('#template-account').value;
    if (!accountId) { alert('Elegí una cuenta.'); return; }
    payload.payment_account_id = accountId;
    payload.default_participants = [];
  } else {
    const participants = [...$('#template-participants').querySelectorAll('.participant-chip.selected')].map(c => c.dataset.userId);
    payload.payment_account_id = null;
    payload.default_participants = participants;
  }

  const { error } = id
    ? await sb.from('fixed_expense_templates').update(payload).eq('id', id)
    : await sb.from('fixed_expense_templates').insert(payload);
  if (error) { alert('Error: ' + error.message); return; }
  $('#modal-template').classList.add('hidden');
  await loadGastos();
});

$('#btn-delete-template').addEventListener('click', async () => {
  const id = $('#template-id').value;
  if (!id) return;
  if (!confirm('¿Eliminar este gasto fijo?')) return;
  await sb.from('fixed_expense_templates').delete().eq('id', id);
  $('#modal-template').classList.add('hidden');
  await loadGastos();
});

// ----- Modal gasto -----
$('#btn-add-expense').addEventListener('click', () => openExpenseModal(null));
$('#btn-cancel-expense').addEventListener('click', () => $('#modal-expense').classList.add('hidden'));

$('#expense-type-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented-btn');
  if (!btn) return;
  $$('#expense-type-toggle .segmented-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const isExterna = btn.dataset.type === 'cuenta_externa';
  $('#expense-compartido-fields').classList.toggle('hidden', isExterna);
  $('#expense-cuenta-fields').classList.toggle('hidden', !isExterna);
});

function currentExpenseType() {
  return $('#expense-type-toggle .segmented-btn.active')?.dataset.type || 'compartido';
}

function applyTemplateToExpenseForm(t) {
  $('#expense-description').value = t.name;
  if (t.default_amount) $('#expense-amount').value = t.default_amount;
  $('#expense-category').value = t.category_id || '';
  $('#expense-is-fixed').value = '1';

  $$('#expense-type-toggle .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.type === t.expense_type));
  const isExterna = t.expense_type === 'cuenta_externa';
  $('#expense-compartido-fields').classList.toggle('hidden', isExterna);
  $('#expense-cuenta-fields').classList.toggle('hidden', !isExterna);

  if (isExterna) {
    $('#expense-account').value = t.payment_account_id || '';
  } else {
    const wanted = new Set(t.default_participants || []);
    $$('#expense-participants .participant-chip').forEach(chip => {
      chip.classList.toggle('selected', wanted.has(chip.dataset.userId));
    });
  }
  $('#expense-amount').focus();
}

function openExpenseModal(expenseId) {
  $('#form-expense').reset();
  $('#expense-is-fixed').value = '';
  $('#btn-delete-expense').classList.add('hidden');
  $('#expense-date').value = todayStr();

  // Selector rápido de gastos fijos (solo al crear uno nuevo)
  $('#expense-templates-picker').classList.toggle('hidden', !!expenseId || templatesCache.length === 0);
  const chipsDiv = $('#expense-templates-chips');
  chipsDiv.innerHTML = '';
  templatesCache.forEach(t => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'product-chip';
    chip.innerHTML = `<span class="emoji">📌</span> ${escapeHtml(t.name)}`;
    chip.addEventListener('click', () => applyTemplateToExpenseForm(t));
    chipsDiv.appendChild(chip);
  });

  // Categoría
  $('#expense-category').innerHTML = '<option value="">Sin categoría</option>' +
    categoriesCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  // Cuenta externa
  $('#expense-account').innerHTML = accountsCache.length
    ? accountsCache.map(a => `<option value="${a.id}">${escapeHtml(accountLabel(a))}</option>`).join('')
    : '<option value="">No hay cuentas cargadas — agregá una en la pestaña "Cuentas"</option>';

  // Pagado por: admin puede elegir, el resto queda fijo en sí mismo
  const eligible = usersWithModuleAccess('gastos');
  if (myProfile?.is_admin) {
    $('#expense-paid-by-display').classList.add('hidden');
    $('#expense-paid-by-select').classList.remove('hidden');
    $('#expense-paid-by-select').innerHTML = eligible.map(p =>
      `<option value="${p.user_id}">${escapeHtml(p.display_name)}${p.user_id === currentUser.id ? ' (vos)' : ''}</option>`
    ).join('');
  } else {
    $('#expense-paid-by-display').classList.remove('hidden');
    $('#expense-paid-by-select').classList.add('hidden');
  }

  const participantsDiv = $('#expense-participants');
  participantsDiv.innerHTML = '';
  const existingSplits = expenseId ? expenseSplitsCache.filter(s => s.expense_id === expenseId).map(s => s.user_id) : eligible.map(p => p.user_id);
  eligible.forEach(p => {
    const chip = document.createElement('span');
    chip.className = 'participant-chip' + (existingSplits.includes(p.user_id) ? ' selected' : '');
    chip.textContent = p.display_name;
    chip.dataset.userId = p.user_id;
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    participantsDiv.appendChild(chip);
  });

  // Tipo de gasto (por defecto: compartido)
  $$('#expense-type-toggle .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'compartido'));
  $('#expense-compartido-fields').classList.remove('hidden');
  $('#expense-cuenta-fields').classList.add('hidden');

  if (expenseId) {
    const exp = expensesCache.find(e => e.id === expenseId);
    $('#modal-expense-title').textContent = 'Editar gasto';
    $('#expense-id').value = exp.id;
    $('#expense-description').value = exp.description;
    $('#expense-amount').value = exp.amount;
    $('#expense-date').value = exp.expense_date;
    $('#expense-category').value = exp.category_id || '';
    $('#expense-notes').value = exp.notes || '';
    $('#expense-is-fixed').value = exp.is_fixed ? '1' : '';
    $('#btn-delete-expense').classList.remove('hidden');

    if (exp.expense_type === 'cuenta_externa') {
      $$('#expense-type-toggle .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'cuenta_externa'));
      $('#expense-compartido-fields').classList.add('hidden');
      $('#expense-cuenta-fields').classList.remove('hidden');
      $('#expense-account').value = exp.payment_account_id || '';
    } else {
      $('#expense-paid-by').value = exp.paid_by;
      $('#expense-paid-by-display').textContent = profileName(exp.paid_by);
      if (myProfile?.is_admin) $('#expense-paid-by-select').value = exp.paid_by;
    }
  } else {
    $('#modal-expense-title').textContent = 'Nuevo gasto';
    $('#expense-id').value = '';
    $('#expense-paid-by').value = currentUser.id;
    $('#expense-paid-by-display').textContent = profileName(currentUser.id) + ' (vos)';
    if (myProfile?.is_admin) $('#expense-paid-by-select').value = currentUser.id;
  }
  $('#modal-expense').classList.remove('hidden');
}

$('#form-expense').addEventListener('submit', async (e) => {
  e.preventDefault();
  const expenseId = $('#expense-id').value || null;
  const description = $('#expense-description').value.trim();
  const amount = Number($('#expense-amount').value);
  const expenseDate = $('#expense-date').value;
  const categoryId = $('#expense-category').value || null;
  const notes = $('#expense-notes').value.trim() || null;
  const isFixed = $('#expense-is-fixed').value === '1';
  const expenseType = currentExpenseType();

  try {
    if (expenseType === 'cuenta_externa') {
      const accountId = $('#expense-account').value;
      if (!accountId) { alert('Elegí una cuenta (o cargá una primero en la pestaña "Cuentas").'); return; }

      const payload = {
        description, amount, expense_date: expenseDate, category_id: categoryId, notes, is_fixed: isFixed,
        expense_type: 'cuenta_externa', payment_account_id: accountId,
        paid_by: null, created_by: currentUser.id,
      };
      let savedId = expenseId;
      if (expenseId) {
        const { error } = await sb.from('expenses').update(payload).eq('id', expenseId);
        if (error) throw new Error(error.message);
        await sb.from('expense_splits').delete().eq('expense_id', expenseId);
      } else {
        const { data, error } = await sb.from('expenses').insert(payload).select().single();
        if (error) throw new Error(error.message);
        savedId = data.id;
      }
    } else {
      const paidBy = myProfile?.is_admin ? $('#expense-paid-by-select').value : $('#expense-paid-by').value;
      const participants = [...$('#expense-participants').querySelectorAll('.participant-chip.selected')].map(c => c.dataset.userId);
      if (participants.length === 0) { alert('Elegí al menos un participante.'); return; }

      const payload = {
        description, amount, expense_date: expenseDate, category_id: categoryId, notes, is_fixed: isFixed,
        expense_type: 'compartido', payment_account_id: null,
        paid_by: paidBy, created_by: currentUser.id,
      };
      let savedId = expenseId;
      if (expenseId) {
        const { error } = await sb.from('expenses').update(payload).eq('id', expenseId);
        if (error) throw new Error(error.message);
        await sb.from('expense_splits').delete().eq('expense_id', expenseId);
      } else {
        const { data, error } = await sb.from('expenses').insert(payload).select().single();
        if (error) throw new Error(error.message);
        savedId = data.id;
      }
      const share = Math.round((amount / participants.length) * 100) / 100;
      const splits = participants.map((uid, idx) => ({
        expense_id: savedId, user_id: uid,
        share_amount: idx === participants.length - 1 ? Math.round((amount - share * (participants.length - 1)) * 100) / 100 : share,
      }));
      const { error: splitErr } = await sb.from('expense_splits').insert(splits);
      if (splitErr) throw new Error(splitErr.message);
    }

    $('#modal-expense').classList.add('hidden');
    await loadGastos();
  } catch (err) {
    alert('No se pudo guardar el gasto: ' + err.message);
  }
});

$('#btn-delete-expense').addEventListener('click', async () => {
  const id = $('#expense-id').value;
  if (!id) return;
  if (!confirm('¿Eliminar este gasto?')) return;
  await sb.from('expenses').delete().eq('id', id);
  $('#modal-expense').classList.add('hidden');
  await loadGastos();
});

// ----- Modal registrar pago -----
$('#btn-add-settlement').addEventListener('click', () => {
  $('#form-settlement').reset();
  $('#settlement-from').value = currentUser.id;
  $('#settlement-from-display').textContent = profileName(currentUser.id) + ' (vos)';
  $('#settlement-to').innerHTML = usersWithModuleAccess('gastos')
    .filter(p => p.user_id !== currentUser.id)
    .map(p => `<option value="${p.user_id}">${escapeHtml(p.display_name)}</option>`).join('');
  $('#settlement-date').value = todayStr();
  $('#modal-settlement').classList.remove('hidden');
});
$('#btn-cancel-settlement').addEventListener('click', () => $('#modal-settlement').classList.add('hidden'));

$('#form-settlement').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fromUser = $('#settlement-from').value;
  const toUser = $('#settlement-to').value;
  const amount = Number($('#settlement-amount').value);
  const settledDate = $('#settlement-date').value;
  const notes = $('#settlement-notes').value.trim() || null;
  if (fromUser === toUser) { alert('Elegí dos personas distintas.'); return; }
  const { error } = await sb.from('settlements').insert({ from_user: fromUser, to_user: toUser, amount, settled_date: settledDate, notes });
  if (error) { alert('Error: ' + error.message); return; }
  $('#modal-settlement').classList.add('hidden');
  await loadGastos();
});

// ===================== MÓDULO ADMIN =====================
let loginHistoryCache = [];

async function loadAdmin() {
  const { data: profiles } = await sb.from('app_profiles').select('*').order('display_name');
  allProfiles = profiles || [];
  const { data: perms } = await sb.from('module_permissions').select('*');
  renderAdmin(allProfiles, perms || []);

  const { data: history } = await sb.from('login_history').select('*').order('logged_in_at', { ascending: false }).limit(500);
  loginHistoryCache = history || [];
  populateHistoryUserFilter();
  renderLoginHistory();
}

function populateHistoryUserFilter() {
  const sel = $('#history-filter-user');
  const current = sel.value;
  sel.innerHTML = '<option value="">Todos los usuarios</option>' +
    allProfiles.map(p => `<option value="${p.user_id}">${escapeHtml(p.display_name)}</option>`).join('');
  if (current) sel.value = current;
}

function renderLoginHistory() {
  const container = $('#login-history-list');
  container.innerHTML = '';

  const userFilter = $('#history-filter-user').value;
  const fromFilter = $('#history-filter-from').value; // YYYY-MM-DD
  const toFilter = $('#history-filter-to').value;

  let filtered = loginHistoryCache;
  if (userFilter) filtered = filtered.filter(h => h.user_id === userFilter);
  if (fromFilter) filtered = filtered.filter(h => h.logged_in_at.slice(0, 10) >= fromFilter);
  if (toFilter) filtered = filtered.filter(h => h.logged_in_at.slice(0, 10) <= toFilter);

  if (filtered.length === 0) {
    container.innerHTML = '<p class="hint">Sin accesos que coincidan con el filtro.</p>';
    return;
  }
  filtered.forEach(h => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const when = new Date(h.logged_in_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <div><strong>${escapeHtml(profileName(h.user_id))}</strong> accedió a la app</div>
      <div class="when">${when}</div>
    `;
    container.appendChild(row);
  });
}

$('#history-filter-user').addEventListener('change', renderLoginHistory);
$('#history-filter-from').addEventListener('change', renderLoginHistory);
$('#history-filter-to').addEventListener('change', renderLoginHistory);
$('#btn-clear-history-filters').addEventListener('click', () => {
  $('#history-filter-user').value = '';
  $('#history-filter-from').value = '';
  $('#history-filter-to').value = '';
  renderLoginHistory();
});

function renderAdmin(profiles, perms) {
  const container = $('#users-permissions-list');
  container.innerHTML = '';
  const modules = [
    { key: 'medicamentos', label: 'Medicamentos' },
    { key: 'mercaderia', label: 'Mercadería' },
    { key: 'gastos', label: 'Gastos' },
  ];
  profiles.forEach(p => {
    const card = document.createElement('div');
    card.className = 'user-perm-card';
    let permsHtml = '';
    if (p.is_admin) {
      permsHtml = '<p class="hint">Administrador: acceso total a todos los módulos.</p>';
    } else {
      permsHtml = '<div class="perm-grid"><div></div><div class="perm-label">Ver</div><div class="perm-label">Editar</div>';
      modules.forEach(m => {
        const perm = perms.find(x => x.user_id === p.user_id && x.module === m.key) || { can_read: false, can_write: false };
        permsHtml += `
          <div>${m.label}</div>
          <div><input type="checkbox" data-user="${p.user_id}" data-module="${m.key}" data-field="can_read" ${perm.can_read ? 'checked' : ''} /></div>
          <div><input type="checkbox" data-user="${p.user_id}" data-module="${m.key}" data-field="can_write" ${perm.can_write ? 'checked' : ''} /></div>
        `;
      });
      permsHtml += '</div>';
    }
    card.innerHTML = `
      <span class="uname">${escapeHtml(p.display_name)}</span>${p.is_admin ? '<span class="admin-badge">ADMIN</span>' : ''}
      ${permsHtml}
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('input[type=checkbox]').forEach(chk => {
    chk.addEventListener('change', async () => {
      const userId = chk.dataset.user;
      const module = chk.dataset.module;
      const field = chk.dataset.field;
      const { data: existing } = await sb.from('module_permissions').select('*').eq('user_id', userId).eq('module', module).maybeSingle();
      const payload = {
        user_id: userId, module,
        can_read: field === 'can_read' ? chk.checked : (existing?.can_read ?? true),
        can_write: field === 'can_write' ? chk.checked : (existing?.can_write ?? false),
      };
      // Si se saca "Ver", también se saca "Editar"
      if (field === 'can_read' && !chk.checked) payload.can_write = false;
      await sb.from('module_permissions').upsert(payload);
      await loadAdmin();
    });
  });
}

$('#btn-add-user').addEventListener('click', () => {
  $('#form-new-user').reset();
  $('#new-user-error').textContent = '';
  $('#modal-user').classList.remove('hidden');
});
$('#btn-cancel-user').addEventListener('click', () => $('#modal-user').classList.add('hidden'));

$('#form-new-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#new-user-error').textContent = '';
  const displayName = $('#new-user-displayname').value.trim();
  const username = $('#new-user-username').value.trim();
  const password = $('#new-user-password').value;
  const isAdmin = $('#new-user-admin').checked;
  const submitBtn = $('#form-new-user').querySelector('button[type=submit]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creando...';
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-create-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionData.session.access_token}`,
        apikey: window.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ username, password, display_name: displayName, is_admin: isAdmin }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || 'Error desconocido');
    $('#modal-user').classList.add('hidden');
    await loadAdmin();
  } catch (err) {
    $('#new-user-error').textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Crear';
  }
});

// ---------- PWA: registrar service worker + detectar actualizaciones ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const handleNewWorker = (newWorker) => {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            showUpdateBanner();
          }
        });
      };
      // Si ya había un service worker viejo controlando la página, o se
      // detecta uno nuevo mientras la app está abierta.
      if (reg.waiting) handleNewWorker(reg.waiting);
      reg.addEventListener('updatefound', () => {
        if (reg.installing) handleNewWorker(reg.installing);
      });

      // La app puede quedar abierta mucho tiempo sin recargarse (por
      // eso a veces no se notaba una actualización). Revisamos cada
      // 3 minutos si hay una versión nueva en el servidor.
      setInterval(() => reg.update().catch(() => {}), 3 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

function showUpdateBanner() {
  if ($('#update-banner')) return; // ya se está mostrando
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `🔄 Hay una versión nueva. Se va a actualizar en cuanto termines lo que estás haciendo.`;
  document.body.appendChild(banner);
  attemptReload();
}

function attemptReload() {
  // No interrumpir si hay un formulario/modal abierto: esperar a que
  // se cierre antes de recargar, para no cortar algo a mitad de carga.
  const modalOpen = document.querySelector('.modal:not(.hidden)');
  if (modalOpen) {
    setTimeout(attemptReload, 1500);
  } else {
    window.location.reload();
  }
}
