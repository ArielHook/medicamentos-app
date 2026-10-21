// cache: 'no-store' evita que el navegador devuelva respuestas viejas
// en celulares/Chrome Android para las consultas a Supabase.
const APP_VERSION = 'beta-12';

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
  global: {
    fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }),
  },
});

// Red de seguridad: antes, un error de JS dentro de un botón "Guardar"
// podía fallar en silencio (no pasaba nada, sin mensaje). Con esto,
// cualquier error inesperado se muestra siempre con un aviso.
window.addEventListener('error', (ev) => {
  console.error('Error no controlado:', ev.error || ev.message);
  alert('Ocurrió un error inesperado y no se pudo completar la acción.\n\nDetalle: ' + (ev.error?.message || ev.message || 'desconocido') + '\n\nProbá recargar la app (o cerrarla y volver a abrirla) e intentar de nuevo.');
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('Promesa no controlada:', ev.reason);
  alert('Ocurrió un error inesperado y no se pudo completar la acción.\n\nDetalle: ' + (ev.reason?.message || ev.reason || 'desconocido') + '\n\nProbá recargar la app (o cerrarla y volver a abrirla) e intentar de nuevo.');
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
  renderBottomNav(visible, isAdmin);
  switchModule(currentModule);
}

// BETA: barra de navegación inferior (reemplaza la lista de módulos del menú ☰)
const NAV_ICONS = {
  medicamentos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 20.5a5 5 0 0 1-7-7l9-9a5 5 0 0 1 7 7z"/><path d="M8.5 8.5l7 7"/></svg>',
  mercaderia: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.5 12h11l2-8H6"/></svg>',
  gastos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14.5" r="1.2"/></svg>',
  admin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg>',
};
const NAV_LABELS = { medicamentos: 'Remedios', mercaderia: 'Compras', gastos: 'Gastos', admin: 'Admin' };
function renderBottomNav(visible, isAdmin) {
  const nav = $('#bottom-nav');
  if (!nav) return;
  const keys = visible.map(m => m.key);
  if (isAdmin) keys.push('admin');
  nav.innerHTML = '';
  keys.forEach(k => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.key = k;
    b.innerHTML = `${NAV_ICONS[k] || ''}<span>${NAV_LABELS[k] || k}</span>`;
    b.addEventListener('click', () => switchModule(k));
    nav.appendChild(b);
  });
  nav.classList.toggle('hidden', keys.length === 0);
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
  $$('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.key === key));
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
  $('#app-version-label').textContent = `Versión ${APP_VERSION}`;
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


// ---------- RECUPERACIÓN DE CONTRASEÑA POR CORREO ----------
async function recoveryCall(payload, withSession) {
  const headers = { 'Content-Type': 'application/json', apikey: window.SUPABASE_ANON_KEY };
  if (withSession) {
    const { data } = await sb.auth.getSession();
    headers.Authorization = `Bearer ${data.session.access_token}`;
  } else {
    headers.Authorization = `Bearer ${window.SUPABASE_ANON_KEY}`;
  }
  const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/account-recovery`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(out.error || 'Error de conexión');
  return out;
}
async function refreshRecoveryStatus() {
  const st = $('#recovery-status');
  $('#recovery-error').textContent = '';
  $('#recovery-confirm').classList.add('hidden');
  try {
    const r = await recoveryCall({ action: 'status' }, true);
    $('#btn-recovery-remove').classList.toggle('hidden', !r.email);
    if (r.email && r.verified) { st.textContent = `✔ Confirmado: ${r.email}`; $('#recovery-email').value = r.email; }
    else if (r.email) { st.textContent = `Pendiente de confirmar: ${r.email}`; $('#recovery-email').value = r.email; $('#recovery-confirm').classList.remove('hidden'); }
    else { st.textContent = 'Sin correo. Agregá uno para poder recuperar tu contraseña si la olvidás.'; $('#recovery-email').value = ''; }
  } catch (e) { st.textContent = 'No se pudo cargar el estado del correo.'; }
}
$('#menu-my-account').addEventListener('click', refreshRecoveryStatus);
$('#btn-recovery-save').addEventListener('click', async () => {
  const email = $('#recovery-email').value.trim();
  const err = $('#recovery-error'); err.textContent = '';
  if (!email) { err.textContent = 'Ingresá un correo.'; return; }
  const btn = $('#btn-recovery-save'); btn.disabled = true;
  try { await recoveryCall({ action: 'set_email', email }, true); await refreshRecoveryStatus(); }
  catch (e) { err.textContent = e.message; }
  btn.disabled = false;
});
$('#btn-recovery-confirm').addEventListener('click', async () => {
  const err = $('#recovery-error'); err.textContent = '';
  try { await recoveryCall({ action: 'confirm_email', code: $('#recovery-code').value }, true); $('#recovery-code').value = ''; await refreshRecoveryStatus(); }
  catch (e) { err.textContent = e.message; }
});
$('#btn-recovery-remove').addEventListener('click', async () => {
  if (!confirm('¿Quitar el correo de recuperación?')) return;
  try { await recoveryCall({ action: 'remove_email' }, true); await refreshRecoveryStatus(); }
  catch (e) { $('#recovery-error').textContent = e.message; }
});

$('#btn-forgot').addEventListener('click', () => {
  $('#forgot-username').value = $('#login-username').value;
  $('#forgot-error').textContent = '';
  $('#forgot-step1').classList.remove('hidden');
  $('#forgot-step2').classList.add('hidden');
  $('#modal-forgot').classList.remove('hidden');
});
$('#btn-forgot-close').addEventListener('click', () => $('#modal-forgot').classList.add('hidden'));
$('#btn-forgot-send').addEventListener('click', async () => {
  const username = $('#forgot-username').value.trim();
  const err = $('#forgot-error'); err.textContent = '';
  if (!username) { err.textContent = 'Ingresá tu usuario.'; return; }
  const btn = $('#btn-forgot-send'); btn.disabled = true;
  try { await recoveryCall({ action: 'request_reset', username }, false); $('#forgot-step1').classList.add('hidden'); $('#forgot-step2').classList.remove('hidden'); }
  catch (e) { err.textContent = e.message; }
  btn.disabled = false;
});
$('#btn-forgot-reset').addEventListener('click', async () => {
  const err = $('#forgot-error'); err.textContent = '';
  const btn = $('#btn-forgot-reset'); btn.disabled = true;
  try {
    await recoveryCall({ action: 'reset_password', username: $('#forgot-username').value.trim(), code: $('#forgot-code').value, password: $('#forgot-new-password').value }, false);
    $('#modal-forgot').classList.add('hidden');
    $('#login-username').value = $('#forgot-username').value.trim();
    $('#login-password').value = '';
    $('#login-error').textContent = '';
    alert('Contraseña cambiada. Ya podés ingresar con la nueva.');
  } catch (e) { err.textContent = e.message; }
  btn.disabled = false;
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

// ---------- REGISTRO DE ACTIVIDAD (para Admin) ----------
function logActivity(module, action, description, details) {
  sb.from('activity_log').insert({
    user_id: currentUser.id, module, action, description, details: details || null,
  }).then(() => {});
}

function money(n) {
  return `$${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
}

// Compara dos versiones de un gasto y devuelve un texto tipo
// "Monto: $150.000 → $170.000" para cada campo que cambió.
function diffExpense(before, after, beforeParticipants, afterParticipants) {
  const lines = [];
  if (before.description !== after.description) lines.push(`Descripción: "${before.description}" → "${after.description}"`);
  if (Number(before.amount) !== Number(after.amount)) lines.push(`Monto: ${money(before.amount)} → ${money(after.amount)}`);
  if (before.expense_date !== after.expense_date) lines.push(`Fecha: ${before.expense_date} → ${after.expense_date}`);
  if ((before.category_id || null) !== (after.category_id || null)) {
    const catName = (id) => categoriesCache.find(c => c.id === id)?.name || 'Sin categoría';
    lines.push(`Categoría: ${catName(before.category_id)} → ${catName(after.category_id)}`);
  }
  if (before.expense_type !== after.expense_type) {
    lines.push(`Tipo: ${before.expense_type === 'cuenta_externa' ? 'Cuenta externa' : 'Compartido'} → ${after.expense_type === 'cuenta_externa' ? 'Cuenta externa' : 'Compartido'}`);
  }
  if ((before.paid_by || null) !== (after.paid_by || null)) {
    lines.push(`Pagó: ${before.paid_by ? profileName(before.paid_by) : '—'} → ${after.paid_by ? profileName(after.paid_by) : '—'}`);
  }
  if ((before.payment_account_id || null) !== (after.payment_account_id || null)) {
    const accName = (id) => { const a = accountsCache.find(x => x.id === id); return a ? accountLabel(a) : '—'; };
    lines.push(`Cuenta: ${accName(before.payment_account_id)} → ${accName(after.payment_account_id)}`);
  }
  if (beforeParticipants && afterParticipants) {
    const beforeSet = new Set(beforeParticipants);
    const afterSet = new Set(afterParticipants);
    const added = afterParticipants.filter(id => !beforeSet.has(id)).map(profileName);
    const removed = beforeParticipants.filter(id => !afterSet.has(id)).map(profileName);
    if (added.length) lines.push(`Participantes: se agregó a ${added.join(', ')}`);
    if (removed.length) lines.push(`Participantes: se quitó a ${removed.join(', ')}`);
  }
  return lines.join('\n');
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
  renderItinerarioResumen();
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
    const gTotal = items.filter(si => medsCache.some(m => m.id === si.medication_id)).length;
    const gDone = items.filter(si => doseLogToday.has(si.id) && medsCache.some(m => m.id === si.medication_id)).length;
    const gStatus = document.createElement('span');
    gStatus.className = 'group-status ' + (gTotal > 0 && gDone === gTotal ? 'done' : 'pending');
    gStatus.textContent = gTotal > 0 && gDone === gTotal ? 'completo' : `${gDone}/${gTotal}`;
    header.firstElementChild.appendChild(gStatus);
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

// BETA: tarjeta de resumen (anillo de progreso + stock bajo)
function renderItinerarioResumen() {
  let box = $('#itinerario-resumen');
  if (!box) {
    box = document.createElement('div');
    box.id = 'itinerario-resumen';
    box.className = 'resumen-row';
    $('#itinerario-list').parentNode.insertBefore(box, $('#itinerario-list'));
  }
  const valid = scheduleCache.filter(si => medsCache.some(m => m.id === si.medication_id));
  const total = valid.length;
  const done = valid.filter(si => doseLogToday.has(si.id)).length;
  const pct = total ? done / total : 0;
  const C = 2 * Math.PI * 22;
  const lowCount = medsCache.filter(med => {
    const s = stockCache.find(x => x.medication_id === med.id);
    const days = daysRemainingFor(med.id);
    return s && days !== null && days <= Number(s.low_stock_days_threshold);
  }).length;
  box.innerHTML = `
    <div class="resumen-card">
      <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">
        <circle cx="27" cy="27" r="22" fill="none" stroke="var(--surface-2)" stroke-width="6"/>
        <circle cx="27" cy="27" r="22" fill="none" stroke="var(--navy)" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}" transform="rotate(-90 27 27)"/>
      </svg>
      <div><div class="resumen-big">${done} de ${total}</div><div class="resumen-sub">tomas de hoy</div></div>
    </div>
    <div class="resumen-card ${lowCount ? 'warn' : ''}">
      <div><div class="resumen-big">${lowCount}</div><div class="resumen-sub">${lowCount === 1 ? 'con stock bajo' : 'con stock bajo'}</div></div>
    </div>`;
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
    renderItinerarioResumen();
  } else {
    await sb.from('dose_log').insert({
      schedule_item_id: scheduleItemId,
      taken_date: todayStr(),
      status: 'taken',
    });
    doseLogToday.add(scheduleItemId);
    btn.classList.add('checked');
    btn.textContent = '✓';
    renderItinerarioResumen();
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
          <div class="meta">Quedan hoy: ${(effectiveQty !== null ? effectiveQty : s.current_quantity).toLocaleString('es-AR')} ${escapeHtml(s.unit)} · Consumo: ${daily}/día</div>
          ${zeroDate ? `<div class="zero-date">${isLow ? '⚠️ ' : ''}Se agota: ${formatDate(zeroDate)} (${days} días)</div>` : `<div class="meta">Sin horarios cargados</div>`}
        </div>
      </div>
      ${days !== null ? `<div class="stock-bar" aria-hidden="true"><div class="stock-bar-fill ${isLow ? 'low' : ''}" style="width:${Math.max(4, Math.min(100, Math.round(days / 30 * 100)))}%"></div></div>
      <div class="stock-bar-label">${Math.max(0, days)} días de stock</div>` : ''}
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
  // Las fechas "YYYY-MM-DD" (sin hora) se interpretan en hora local: con new Date('2026-10-17')
  // JS las toma como UTC y en Argentina (UTC-3) se mostraban un día antes.
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) d = new Date(d + 'T00:00:00');
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
      <span>${emojiFor(p.name)} ${escapeHtml(p.name)} <span class="shop-meta">(quedan ${Number(p.quantity).toLocaleString('es-AR')} ${escapeHtml(p.unit)})</span></span>
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
  const count = expensesCache.length;
  await sb.from('expenses').delete().not('id', 'is', null);
  logActivity('gastos', 'delete', `Borró TODOS los gastos (${count} en total)`);
  await loadGastos();
});

$('#btn-clear-settlements').addEventListener('click', async () => {
  if (!confirm('Esto borra TODOS los pagos registrados entre usuarios. ¿Continuar?')) return;
  const count = settlementsCache.length;
  await sb.from('settlements').delete().not('id', 'is', null);
  logActivity('gastos', 'delete', `Borró TODOS los pagos registrados (${count} en total)`);
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
  $$('.date-preset-btn').forEach(b => b.classList.remove('active'));
  renderExpenses();
});
$('#btn-toggle-expense-filters').addEventListener('click', () => {
  $('#expense-filter-bar').classList.toggle('hidden');
});

$$('.date-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth();
    const iso = (d) => d.toISOString().slice(0, 10);
    if (btn.dataset.preset === 'today') {
      $('#expense-filter-from').value = iso(today);
      $('#expense-filter-to').value = iso(today);
    } else if (btn.dataset.preset === 'this-month') {
      $('#expense-filter-from').value = iso(new Date(y, m, 1));
      $('#expense-filter-to').value = iso(new Date(y, m + 1, 0));
    } else if (btn.dataset.preset === 'last-month') {
      $('#expense-filter-from').value = iso(new Date(y, m - 1, 1));
      $('#expense-filter-to').value = iso(new Date(y, m, 0));
    }
    $$('.date-preset-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderExpenses();
  });
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
    $('#expenses-summary').classList.add('hidden');
    if (!$('#expenses-calendar').classList.contains('hidden')) renderExpensesCalendar();
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
      subline = `${formatDate(exp.expense_date)} · 💳 ${escapeHtml(account ? accountLabel(account) : 'Cuenta eliminada')}${cat ? ' · ' + escapeHtml(cat.name) : ''}`;
    } else {
      subline = `${formatDate(exp.expense_date)} · Pagó ${escapeHtml(profileName(exp.paid_by))} · Entre: ${splits.map(s => escapeHtml(profileName(s.user_id))).join(', ')}${cat ? ' · ' + escapeHtml(cat.name) : ''}`;
    }
    if (exp.is_fixed) subline += ' · <span class="fixed-badge">📌 Fijo</span>';
    row.innerHTML = `
      <div class="top-line">
        <span>${escapeHtml(exp.description)}</span>
        <span class="expense-row-right">
          <span class="expense-amount">$${Number(exp.amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
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
          const exp = expensesCache.find(x => x.id === id);
          await sb.from('expenses').delete().eq('id', id);
          if (exp) logActivity('gastos', 'delete', `Gasto: ${exp.description} (${money(exp.amount)})`);
          await loadGastos();
        }
      }
    });
  });

  const total = filtered.reduce((sum, exp) => sum + Number(exp.amount), 0);
  const summary = $('#expenses-summary');
  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="expenses-summary-item">
      <div class="expenses-summary-value">${filtered.length}</div>
      <div class="expenses-summary-label">Gasto${filtered.length === 1 ? '' : 's'}</div>
    </div>
    <div class="expenses-summary-item">
      <div class="expenses-summary-value">$${total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</div>
      <div class="expenses-summary-label">Total</div>
    </div>
  `;
  if (!$('#expenses-calendar').classList.contains('hidden')) renderExpensesCalendar();
}

// ----- Vista calendario de gastos -----
let expensesCalendarMonth = startOfDay(new Date());
expensesCalendarMonth.setDate(1);
let selectedExpenseDay = null;

$('#expenses-view-list').addEventListener('click', () => {
  $('#expenses-view-list').classList.add('active');
  $('#expenses-view-calendar').classList.remove('active');
  $('#expenses-list').classList.remove('hidden');
  $('#expenses-summary').classList.remove('hidden');
  $('#expenses-calendar').classList.add('hidden');
});
$('#expenses-view-calendar').addEventListener('click', () => {
  $('#expenses-view-calendar').classList.add('active');
  $('#expenses-view-list').classList.remove('active');
  $('#expenses-calendar').classList.remove('hidden');
  $('#expenses-list').classList.add('hidden');
  $('#expenses-summary').classList.add('hidden');
  selectedExpenseDay = null;
  renderExpensesCalendar();
});

function renderExpensesCalendar() {
  const container = $('#expenses-calendar');
  container.innerHTML = '';
  const filtered = getFilteredExpenses();

  const monthLabel = expensesCalendarMonth.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  const nav = document.createElement('div');
  nav.className = 'calendar-nav';
  nav.innerHTML = `
    <button type="button" id="exp-cal-prev" class="btn-icon-small">‹</button>
    <div class="calendar-month-label">${capitalize(monthLabel)}</div>
    <button type="button" id="exp-cal-next" class="btn-icon-small">›</button>
  `;
  container.appendChild(nav);

  // Mapa día -> {total, items}
  const byDay = {};
  filtered.forEach(exp => {
    const d = new Date(exp.expense_date + 'T00:00:00');
    const key = d.toDateString();
    if (!byDay[key]) byDay[key] = { total: 0, items: [] };
    byDay[key].total += Number(exp.amount);
    byDay[key].items.push(exp);
  });

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'calendar-dow';
    h.textContent = d;
    grid.appendChild(h);
  });

  const firstDay = new Date(expensesCalendarMonth);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(expensesCalendarMonth.getFullYear(), expensesCalendarMonth.getMonth() + 1, 0).getDate();
  const today = startOfDay(new Date());

  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-cell empty';
    grid.appendChild(empty);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(expensesCalendarMonth.getFullYear(), expensesCalendarMonth.getMonth(), day);
    const key = cellDate.toDateString();
    const dayData = byDay[key];
    const cell = document.createElement('div');
    cell.className = 'calendar-cell'
      + (dayData ? ' has-event' : '')
      + (cellDate.getTime() === today.getTime() ? ' is-today' : '')
      + (selectedExpenseDay === key ? ' selected' : '');
    cell.innerHTML = `
      <div class="cal-daynum">${day}</div>
      ${dayData ? `<div class="cal-amount">$${Math.round(dayData.total).toLocaleString('es-AR')}</div>` : ''}
    `;
    if (dayData) {
      cell.addEventListener('click', () => {
        selectedExpenseDay = selectedExpenseDay === key ? null : key;
        renderExpensesCalendar();
      });
    }
    grid.appendChild(cell);
  }
  container.appendChild(grid);

  // Detalle del día seleccionado (o resumen del mes si no hay ninguno)
  const detail = document.createElement('div');
  detail.className = 'calendar-events-list';
  if (selectedExpenseDay && byDay[selectedExpenseDay]) {
    const dayData = byDay[selectedExpenseDay];
    const dayDate = new Date(selectedExpenseDay);
    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = `${formatDate(dayDate)} — $${dayData.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
    detail.appendChild(title);
    dayData.items.forEach(exp => {
      const cat = categoriesCache.find(c => c.id === exp.category_id);
      const account = accountsCache.find(a => a.id === exp.payment_account_id);
      const row = document.createElement('div');
      row.className = 'calendar-event-row';
      const who = exp.expense_type === 'cuenta_externa'
        ? `💳 ${account ? accountLabel(account) : 'Cuenta eliminada'}`
        : `Pagó ${escapeHtml(profileName(exp.paid_by))}`;
      row.innerHTML = `<strong>${escapeHtml(exp.description)}</strong> — $${Number(exp.amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })}<br><span class="shop-meta">${who}${cat ? ' · ' + escapeHtml(cat.name) : ''}</span>`;
      detail.appendChild(row);
    });
  } else {
    const monthEvents = Object.keys(byDay).filter(key => {
      const d = new Date(key);
      return d.getFullYear() === expensesCalendarMonth.getFullYear() && d.getMonth() === expensesCalendarMonth.getMonth();
    });
    if (monthEvents.length === 0) {
      detail.innerHTML = '<p class="hint">Sin gastos este mes.</p>';
    } else {
      detail.innerHTML = '<p class="hint">Tocá un día para ver el detalle.</p>';
    }
  }
  container.appendChild(detail);

  $('#exp-cal-prev').addEventListener('click', () => {
    expensesCalendarMonth.setMonth(expensesCalendarMonth.getMonth() - 1);
    selectedExpenseDay = null;
    renderExpensesCalendar();
  });
  $('#exp-cal-next').addEventListener('click', () => {
    expensesCalendarMonth.setMonth(expensesCalendarMonth.getMonth() + 1);
    selectedExpenseDay = null;
    renderExpensesCalendar();
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

  // BETA: gasto compartido del mes
  const monthKey = todayStr().slice(0, 7);
  const monthExp = expensesCache.filter(exp => exp.expense_type !== 'cuenta_externa' && String(exp.expense_date).startsWith(monthKey));
  const monthTotal = monthExp.reduce((sum, exp) => sum + Number(exp.amount), 0);
  const monthName = capitalize(new Date().toLocaleDateString('es-AR', { month: 'long' }));
  container.innerHTML = `
    <div class="month-card" id="month-card" role="button" tabindex="0" aria-label="Ver los gastos del mes">
      <div class="month-label">Gasto compartido · ${escapeHtml(monthName)} <span class="month-more">Ver detalle ›</span></div>
      <div class="month-amount">${money(monthTotal)}</div>
      <div class="month-sub">${monthExp.length} ${monthExp.length === 1 ? 'gasto' : 'gastos'}${monthExp.length ? ' · promedio ' + money(monthTotal / monthExp.length) : ''}</div>
    </div>
    <h3 class="section-title">Balance de cada uno</h3><div class="balance-list"></div>`;
  const monthCard = container.querySelector('#month-card');
  monthCard.addEventListener('click', () => openMonthSheet(monthKey));
  monthCard.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMonthSheet(monthKey); } });
  const list = container.querySelector('.balance-list');
  const maxAbs = Math.max(1, ...eligible.map(p => Math.abs(net[p.user_id] || 0)));
  eligible.forEach(p => {
    const amount = Math.round((net[p.user_id] || 0) * 100) / 100;
    const isPositive = amount > 0.01;
    const isNegative = amount < -0.01;
    const status = isPositive ? 'a favor' : isNegative ? 'pendiente' : 'al día';
    const pct = Math.round(Math.abs(amount) / maxAbs * 50);
    const row = document.createElement('div');
    row.className = 'balance-row ' + (isPositive ? 'positive' : isNegative ? 'negative' : 'neutral');
    row.innerHTML = `
      <div class="balance-row-top">
        <span class="balance-row-name">${escapeHtml(p.display_name)} <small>${status}</small></span>
        <span class="balance-row-amount">${isPositive ? '+ ' : isNegative ? '- ' : ''}${(isPositive || isNegative) ? money(Math.abs(amount)) : '—'}</span>
      </div>
      <div class="balance-track"><div class="balance-fill" style="width:${pct}%"></div></div>`;
    list.appendChild(row);
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
      const canPay = canWrite('gastos') && (myProfile?.is_admin || d.from === currentUser.id);
      row.innerHTML = `<span class="debt-text"><strong>${escapeHtml(profileName(d.from))}</strong> → <strong>${escapeHtml(profileName(d.to))}</strong></span><strong class="debt-amount">${money(d.amount)}</strong>${canPay ? '<button type="button" class="btn-pay">Pagar</button>' : ''}`;
      const btn = row.querySelector('.btn-pay');
      if (btn) btn.addEventListener('click', () => payDebt(d));
      container.appendChild(row);
    });
  }
}

// BETA: ventana desde abajo con los gastos compartidos de un mes
function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function openMonthSheet(key) {
  let sheet = $('#modal-month');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'modal-month';
    sheet.className = 'modal hidden';
    sheet.innerHTML = '<div class="modal-content month-sheet"></div>';
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.classList.add('hidden'); });
    document.body.appendChild(sheet);
  }
  const [y, m] = key.split('-').map(Number);
  const label = capitalize(new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }));
  const items = expensesCache
    .filter(exp => exp.expense_type !== 'cuenta_externa' && String(exp.expense_date).startsWith(key))
    .sort((p, q) => String(q.expense_date).localeCompare(String(p.expense_date)));
  const total = items.reduce((sum, exp) => sum + Number(exp.amount), 0);
  const rows = items.length === 0
    ? '<p class="hint" style="text-align:center;padding:18px 0;">No hay gastos compartidos en este mes.</p>'
    : items.map(exp => {
        const cat = categoriesCache.find(c => c.id === exp.category_id);
        return `<div class="month-item">
          <div class="month-item-main"><div class="month-item-title">${escapeHtml(exp.description)}</div>
          <div class="month-item-meta">${formatDate(exp.expense_date)} · Pagó ${escapeHtml(profileName(exp.paid_by))}${cat ? ' · ' + escapeHtml(cat.name) : ''}</div></div>
          <div class="month-item-amount">${money(exp.amount)}</div></div>`;
      }).join('');
  const box = sheet.querySelector('.month-sheet');
  box.innerHTML = `
    <div class="month-sheet-nav">
      <button type="button" class="btn-icon-small" id="month-prev" aria-label="Mes anterior">‹</button>
      <div class="month-sheet-title">${escapeHtml(label)}</div>
      <button type="button" class="btn-icon-small" id="month-next" aria-label="Mes siguiente">›</button>
    </div>
    <div class="month-sheet-total">${money(total)}<small>${items.length} ${items.length === 1 ? 'gasto' : 'gastos'}</small></div>
    <div class="month-sheet-list">${rows}</div>
    <button type="button" class="btn-secondary btn-block" id="month-close" style="margin-top:12px;">Cerrar</button>`;
  box.querySelector('#month-prev').addEventListener('click', () => openMonthSheet(shiftMonthKey(key, -1)));
  box.querySelector('#month-next').addEventListener('click', () => openMonthSheet(shiftMonthKey(key, 1)));
  box.querySelector('#month-close').addEventListener('click', () => sheet.classList.add('hidden'));
  sheet.classList.remove('hidden');
}

// BETA: abre "Registrar pago" ya completado con el ajuste sugerido
function payDebt(d) {
  $('#btn-add-settlement').click();
  if (myProfile?.is_admin) {
    $('#settlement-from-select').value = d.from;
    populateSettlementToOptions();
  }
  $('#settlement-to').value = d.to;
  $('#settlement-amount').value = Math.round(d.amount * 100) / 100;
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
      <div><strong>${escapeHtml(profileName(s.from_user))}</strong> le pagó <strong>${money(s.amount)}</strong> a <strong>${escapeHtml(profileName(s.to_user))}</strong>${s.notes ? ' — ' + escapeHtml(s.notes) : ''}</div>
      <div class="when">${formatDate(s.settled_date)}</div>
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
        logActivity('gastos', 'update', `Categoría: "${c.name}" → "${newName}"`);
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
          logActivity('gastos', 'delete', `Categoría: "${c.name}"`);
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
  logActivity('gastos', 'create', `Categoría: "${name}"`);
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
        logActivity('gastos', 'delete', `Cuenta: ${accountLabel(a)}`);
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
  const before = id ? accountsCache.find(x => x.id === id) : null;
  const { error } = id
    ? await sb.from('payment_accounts').update({ owner_name: ownerName, label }).eq('id', id)
    : await sb.from('payment_accounts').insert({ owner_name: ownerName, label });
  if (error) { alert('Error: ' + error.message); return; }
  if (id) {
    logActivity('gastos', 'update', `Cuenta: ${accountLabel(before)} → ${ownerName} — ${label}`);
  } else {
    logActivity('gastos', 'create', `Cuenta: ${ownerName} — ${label}`);
  }
  $('#modal-payment-account').classList.add('hidden');
  await loadGastos();
});

$('#btn-delete-payment-account').addEventListener('click', async () => {
  const id = $('#payment-account-id').value;
  if (!id) return;
  if (!confirm('¿Eliminar esta cuenta?')) return;
  const a = accountsCache.find(x => x.id === id);
  await sb.from('payment_accounts').delete().eq('id', id);
  if (a) logActivity('gastos', 'delete', `Cuenta: ${accountLabel(a)}`);
  $('#modal-payment-account').classList.add('hidden');
  await loadGastos();
});

// ----- Gastos fijos (plantillas reutilizables) -----
function templateAccountLabel(t) {
  const acc = accountsCache.find(a => a.id === t.payment_account_id);
  return acc ? accountLabel(acc) : '—';
}

// ===== BETA · Gastos fijos: estado del mes, vencimientos y carga masiva =====
function monthKeyNow() { return todayStr().slice(0, 7); }
function byDateDesc(x, y) { return String(y.expense_date).localeCompare(String(x.expense_date)); }

// Un gasto cuenta como "de esta plantilla" si está vinculado a ella; los gastos fijos
// viejos (sin vínculo) se reconocen por tener el mismo nombre.
function templateMatchesExpense(t, exp) {
  if (exp.template_id) return exp.template_id === t.id;
  return !!exp.is_fixed && String(exp.description || '').trim().toLowerCase() === t.name.trim().toLowerCase();
}
function templatePaidThisMonth(t) {
  const key = monthKeyNow();
  return expensesCache.filter(e => String(e.expense_date).startsWith(key) && templateMatchesExpense(t, e)).sort(byDateDesc)[0] || null;
}
// Monto sugerido: el del último mes en que se pagó; si nunca se pagó, el habitual.
function templateSuggestedAmount(t) {
  const last = expensesCache.filter(e => templateMatchesExpense(t, e)).sort(byDateDesc)[0];
  if (last) return Number(last.amount);
  return t.default_amount ? Number(t.default_amount) : null;
}
function templateDueDate(t) {
  if (!t.due_day) return null;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return new Date(now.getFullYear(), now.getMonth(), Math.min(Number(t.due_day), daysInMonth));
}
function monthIndex(dateStr) { const [y, m] = String(dateStr).slice(0, 7).split('-').map(Number); return y * 12 + m - 1; }
function periodLabel(t) {
  return { 2: 'Bimestral', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' }[t.period_months] || '';
}
// Si se pagó dentro de su período (ej. hace 1 mes en uno bimestral), este mes no toca.
function templateSkipInfo(t) {
  const period = t.period_months || 1;
  if (period <= 1) return null;
  const last = expensesCache.filter(e => templateMatchesExpense(t, e)).sort(byDateDesc)[0];
  if (!last) return null;
  const diff = monthIndex(todayStr()) - monthIndex(last.expense_date);
  if (diff <= 0 || diff >= period) return null;
  const next = new Date(Math.floor((monthIndex(last.expense_date) + period) / 12), (monthIndex(last.expense_date) + period) % 12, 1);
  return { last, next };
}
function templateIsPending(t) { return !templatePaidThisMonth(t) && !templateSkipInfo(t); }
function templateStatus(t) {
  const paid = templatePaidThisMonth(t);
  if (paid) return { state: 'paid', expense: paid, rank: 3 };
  const skip = templateSkipInfo(t);
  if (skip) return { state: 'skip', ...skip, rank: 4 };
  const due = templateDueDate(t);
  if (!due) return { state: 'pending', due: null, days: null, rank: 2 };
  const days = daysBetween(new Date(), due);
  if (days < 0) return { state: 'overdue', due, days, rank: 0 };
  if (days <= 3) return { state: 'soon', due, days, rank: 1 };
  return { state: 'pending', due, days, rank: 2 };
}
function statusText(st) {
  if (st.state === 'skip') return 'No toca este mes · próximo en ' + capitalize(st.next.toLocaleDateString('es-AR', { month: 'long' }));
  if (st.state === 'paid') return `Pagado · ${formatDate(st.expense.expense_date)} · ${money(st.expense.amount)}`;
  if (st.state === 'overdue') return st.days === -1 ? 'Venció ayer' : `Venció hace ${-st.days} días`;
  if (st.state === 'soon') return st.days === 0 ? 'Vence hoy' : st.days === 1 ? 'Vence mañana' : `Vence en ${st.days} días`;
  if (st.due) return `Vence el ${st.due.getDate()}`;
  return 'Pendiente';
}

function renderFijosAlert() {
  let box = $('#fijos-alert');
  if (!box) {
    box = document.createElement('button');
    box.type = 'button';
    box.id = 'fijos-alert';
    box.className = 'fijos-alert hidden';
    box.addEventListener('click', () => { const tab = document.querySelector('#module-gastos .tab[data-target="gtab-fijos"]'); if (tab) tab.click(); });
    $('#module-gastos').insertBefore(box, $('#module-gastos .tabs'));
  }
  const states = templatesCache.map(templateStatus);
  const overdue = states.filter(s => s.state === 'overdue').length;
  const soon = states.filter(s => s.state === 'soon').length;
  if (!overdue && !soon) { box.classList.add('hidden'); return; }
  const parts = [];
  if (overdue) parts.push(`${overdue} ${overdue === 1 ? 'gasto fijo vencido' : 'gastos fijos vencidos'}`);
  if (soon) parts.push(`${soon} ${soon === 1 ? 'vence' : 'vencen'} en los próximos 3 días`);
  box.textContent = '⏰ ' + parts.join(' · ') + '  — Ver';
  box.classList.toggle('overdue', overdue > 0);
  box.classList.remove('hidden');
}

function renderTemplates() {
  const container = $('#templates-list');
  container.innerHTML = '';
  renderFijosAlert();
  const writeOk = canWrite('gastos');
  if (templatesCache.length === 0) {
    container.innerHTML = '<p class="hint">Todavía no cargaste ningún gasto fijo.</p>';
    return;
  }
  const monthName = capitalize(new Date().toLocaleDateString('es-AR', { month: 'long' }));
  const items = templatesCache.map(t => ({ t, st: templateStatus(t) }))
    .sort((p, q) => p.st.rank - q.st.rank || (p.st.due && q.st.due ? p.st.due - q.st.due : 0) || p.t.name.localeCompare(q.t.name));
  const dueItems = items.filter(i => i.st.state !== 'skip');
  const paidCount = dueItems.filter(i => i.st.state === 'paid').length;
  const unpaid = dueItems.filter(i => i.st.state !== 'paid');
  const missing = unpaid.reduce((sum, i) => sum + (templateSuggestedAmount(i.t) || 0), 0);
  const noAmount = unpaid.filter(i => !templateSuggestedAmount(i.t)).length;

  const summary = document.createElement('div');
  summary.className = 'fijos-summary';
  summary.innerHTML = `
    <div class="fijos-summary-top"><span class="fijos-summary-big">${paidCount} de ${dueItems.length}</span><span class="fijos-summary-label">pagados en ${escapeHtml(monthName)}</span></div>
    <div class="fijos-progress"><div style="width:${Math.round(paidCount / Math.max(dueItems.length, 1) * 100)}%"></div></div>
    <div class="fijos-summary-sub">${unpaid.length === 0 ? 'Todo al día este mes' : `Faltan ${money(missing)}${noAmount ? ` (+ ${noAmount} sin monto)` : ''}`}</div>`;
  container.appendChild(summary);

  if (writeOk && unpaid.length > 0) {
    const batch = document.createElement('button');
    batch.type = 'button';
    batch.className = 'btn-primary btn-block';
    batch.style.marginTop = '0';
    batch.textContent = `Cargar los fijos de ${monthName} (${unpaid.length})`;
    batch.addEventListener('click', openBatchFixedModal);
    container.appendChild(batch);
  }

  items.forEach(({ t, st }) => {
    const cat = categoriesCache.find(c => c.id === t.category_id);
    const row = document.createElement('div');
    row.className = 'fijo-card ' + st.state;
    const detail = t.expense_type === 'cuenta_externa'
      ? `💳 ${templateAccountLabel(t)}`
      : `Entre: ${(t.default_participants || []).map(uid => profileName(uid)).join(', ') || '—'}`;
    const suggested = templateSuggestedAmount(t);
    row.innerHTML = `
      <div class="fijo-main">
        <div class="fijo-title">${escapeHtml(t.name)}${periodLabel(t) ? ` <span class="fijo-period">${periodLabel(t)}</span>` : ''}</div>
        <div class="fijo-status ${st.state}">${escapeHtml(statusText(st))}</div>
        <div class="shop-meta">${cat ? escapeHtml(cat.name) + ' · ' : ''}${detail}${suggested && st.state !== 'paid' ? ` · ~${money(suggested)}` : ''}</div>
      </div>
      <div class="fijo-actions">
        ${writeOk && st.state !== 'paid' ? `<button type="button" class="${st.state === 'skip' ? 'btn-secondary' : 'btn-pay'}" data-load-tpl>Cargar</button>` : ''}
        ${writeOk ? `<button type="button" class="btn-icon-xs" data-edit-tpl="${t.id}" title="Editar">✎</button>
        <button type="button" class="btn-icon-xs danger" data-del-tpl="${t.id}" title="Eliminar">✕</button>` : ''}
      </div>`;
    if (writeOk) {
      const load = row.querySelector('[data-load-tpl]');
      if (load) load.addEventListener('click', () => {
        openExpenseModal(null);
        applyTemplateToExpenseForm(t);
        if (suggested) $('#expense-amount').value = suggested;
      });
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

// Carga todos los fijos que faltan del mes en un solo paso (con monto y fecha editables)
function openBatchFixedModal() {
  const pending = templatesCache.filter(templateIsPending);
  if (pending.length === 0) { alert('Ya están cargados todos los gastos fijos de este mes.'); return; }
  let modal = $('#modal-batch-fixed');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-batch-fixed';
    modal.className = 'modal hidden';
    modal.innerHTML = '<div class="modal-content"></div>';
    document.body.appendChild(modal);
  }
  const monthName = capitalize(new Date().toLocaleDateString('es-AR', { month: 'long' }));
  const box = modal.querySelector('.modal-content');
  const rows = pending.map(t => {
    const sug = templateSuggestedAmount(t);
    const due = templateDueDate(t);
    const dateVal = due && monthKeyNow() === (due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0'))
      ? `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` : todayStr();
    const kind = t.expense_type === 'cuenta_externa' ? `💳 ${templateAccountLabel(t)}` : `Entre: ${(t.default_participants || []).map(profileName).join(', ') || '—'}`;
    return `<div class="batch-row" data-tid="${t.id}">
      <label class="batch-check"><input type="checkbox" checked /> <span>${escapeHtml(t.name)}</span></label>
      <div class="batch-fields">
        <input type="number" class="batch-amount" min="0" step="0.01" value="${sug || ''}" placeholder="Monto" aria-label="Monto de ${escapeHtml(t.name)}" />
        <input type="date" class="batch-date" value="${dateVal}" aria-label="Fecha de ${escapeHtml(t.name)}" />
      </div>
      <div class="batch-meta">${kind}${sug ? '' : ' · completá el monto'}</div>
    </div>`;
  }).join('');
  const payerSelect = myProfile?.is_admin
    ? `<label>¿Quién pagó los compartidos?</label><select id="batch-paid-by">${usersWithModuleAccess('gastos').map(p => `<option value="${p.user_id}" ${p.user_id === currentUser.id ? 'selected' : ''}>${escapeHtml(p.display_name)}${p.user_id === currentUser.id ? ' (vos)' : ''}</option>`).join('')}</select>` : '';
  box.innerHTML = `
    <h2>Cargar fijos de ${escapeHtml(monthName)}</h2>
    <p class="hint">Se usa el monto del último mes. Cambiá los que varían y destildá los que todavía no querés cargar.</p>
    <div class="batch-list">${rows}</div>
    ${payerSelect}
    <div class="batch-total" id="batch-total"></div>
    <div class="modal-actions">
      <div class="spacer"></div>
      <button type="button" class="btn-secondary" id="batch-cancel">Cancelar</button>
      <button type="button" class="btn-primary" id="batch-confirm">Cargar</button>
    </div>`;
  const refresh = () => {
    const sel = [...box.querySelectorAll('.batch-row')].filter(r => r.querySelector('input[type=checkbox]').checked);
    const total = sel.reduce((sum, r) => sum + (Number(r.querySelector('.batch-amount').value) || 0), 0);
    $('#batch-total').textContent = `${sel.length} ${sel.length === 1 ? 'gasto' : 'gastos'} · ${money(total)}`;
    $('#batch-confirm').textContent = sel.length ? `Cargar ${sel.length}` : 'Cargar';
  };
  box.addEventListener('input', refresh);
  box.addEventListener('change', refresh);
  $('#batch-cancel').addEventListener('click', () => modal.classList.add('hidden'));
  $('#batch-confirm').addEventListener('click', () => submitBatchFixed(pending, modal));
  refresh();
  modal.classList.remove('hidden');
}

async function submitBatchFixed(pending, modal) {
  const jobs = [];
  for (const row of modal.querySelectorAll('.batch-row')) {
    if (!row.querySelector('input[type=checkbox]').checked) continue;
    const t = pending.find(x => x.id === row.dataset.tid);
    const amount = Number(row.querySelector('.batch-amount').value);
    const date = row.querySelector('.batch-date').value;
    if (!(amount > 0)) { alert(`Falta el monto de "${t.name}".`); return; }
    if (!date) { alert(`Falta la fecha de "${t.name}".`); return; }
    if (t.expense_type !== 'cuenta_externa' && !(t.default_participants || []).length) {
      alert(`"${t.name}" no tiene personas con quienes repartirlo. Editalo en Gastos fijos o destildalo.`); return;
    }
    jobs.push({ t, amount, date });
  }
  if (jobs.length === 0) { alert('Elegí al menos un gasto.'); return; }
  const paidBy = myProfile?.is_admin ? $('#batch-paid-by').value : currentUser.id;
  const confirmBtn = $('#batch-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Cargando...';
  const failed = [];
  for (const { t, amount, date } of jobs) {
    try {
      const externa = t.expense_type === 'cuenta_externa';
      const payload = {
        description: t.name, amount, expense_date: date, category_id: t.category_id, notes: null,
        is_fixed: true, template_id: t.id, created_by: currentUser.id,
        expense_type: externa ? 'cuenta_externa' : 'compartido',
        payment_account_id: externa ? t.payment_account_id : null,
        paid_by: externa ? null : paidBy,
      };
      const { data, error } = await sb.from('expenses').insert(payload).select().single();
      if (error) throw new Error(error.message);
      if (!externa) {
        const parts = t.default_participants;
        const share = Math.round((amount / parts.length) * 100) / 100;
        const splits = parts.map((uid, idx) => ({
          expense_id: data.id, user_id: uid,
          share_amount: idx === parts.length - 1 ? Math.round((amount - share * (parts.length - 1)) * 100) / 100 : share,
        }));
        const { error: splitErr } = await sb.from('expense_splits').insert(splits);
        if (splitErr) { await sb.from('expenses').delete().eq('id', data.id); throw new Error(splitErr.message); }
      }
      logActivity('gastos', 'create', `Gasto fijo: ${t.name} (${money(amount)})`, externa ? `Carga masiva · Cuenta externa: ${templateAccountLabel(t)}` : `Carga masiva · Pagó: ${profileName(paidBy)}. Entre: ${t.default_participants.map(profileName).join(', ')}`);
    } catch (err) {
      failed.push(`${t.name}: ${err.message}`);
    }
  }
  modal.classList.add('hidden');
  await loadGastos();
  if (failed.length) alert('No se pudieron cargar:\n' + failed.join('\n'));
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
    $('#template-due-day').value = t.due_day || '';
    $('#template-period').value = String(t.period_months || 1);
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

  const periodMonths = Number($('#template-period').value) || 1;
  const dueDayRaw = $('#template-due-day').value;
  const dueDay = dueDayRaw ? Math.min(31, Math.max(1, Math.round(Number(dueDayRaw)))) : null;
  const payload = { name, default_amount: amount, category_id: categoryId, expense_type: expenseType, due_day: dueDay, period_months: periodMonths };
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
  $('#expense-template-id').value = t.id;

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

function populateExpenseTemplateSelect() {
  const sel = $('#expense-template-id');
  sel.innerHTML = '<option value="">Ninguno (gasto común)</option>' +
    templatesCache.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
}
$('#expense-template-id').addEventListener('change', () => {
  const id = $('#expense-template-id').value;
  $('#expense-is-fixed').value = id ? '1' : '';
  const t = templatesCache.find(x => x.id === id);
  if (t && !$('#expense-description').value.trim()) $('#expense-description').value = t.name;
});

function openExpenseModal(expenseId) {
  populateExpenseTemplateSelect();
  $('#form-expense').reset();
  $('#expense-is-fixed').value = '';
  $('#expense-template-id').value = '';
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
    $('#expense-template-id').value = exp.template_id || '';
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
  const templateId = $('#expense-template-id').value || null;
  const isFixed = !!templateId || $('#expense-is-fixed').value === '1';
  const expenseType = currentExpenseType();

  const before = expenseId ? expensesCache.find(x => x.id === expenseId) : null;
  const beforeParticipants = expenseId ? expenseSplitsCache.filter(s => s.expense_id === expenseId).map(s => s.user_id) : null;

  try {
    if (expenseType === 'cuenta_externa') {
      const accountId = $('#expense-account').value;
      if (!accountId) { alert('Elegí una cuenta (o cargá una primero en la pestaña "Cuentas").'); return; }

      const payload = {
        description, amount, expense_date: expenseDate, category_id: categoryId, notes, is_fixed: isFixed, template_id: templateId,
        expense_type: 'cuenta_externa', payment_account_id: accountId,
        paid_by: null, created_by: currentUser.id,
      };
      let savedId = expenseId;
      if (expenseId) {
        const { error } = await sb.from('expenses').update(payload).eq('id', expenseId);
        if (error) throw new Error(error.message);
        await sb.from('expense_splits').delete().eq('expense_id', expenseId);
        const diff = diffExpense(before, payload, beforeParticipants, []);
        logActivity('gastos', 'update', `Gasto: ${description} (${money(amount)})`, diff);
      } else {
        const { data, error } = await sb.from('expenses').insert(payload).select().single();
        if (error) throw new Error(error.message);
        savedId = data.id;
        logActivity('gastos', 'create', `Gasto: ${description} (${money(amount)})`, `Cuenta externa: ${accountLabel(accountsCache.find(a => a.id === accountId))}`);
      }
    } else {
      const paidBy = myProfile?.is_admin ? $('#expense-paid-by-select').value : $('#expense-paid-by').value;
      const participants = [...$('#expense-participants').querySelectorAll('.participant-chip.selected')].map(c => c.dataset.userId);
      if (participants.length === 0) { alert('Elegí al menos un participante.'); return; }

      const payload = {
        description, amount, expense_date: expenseDate, category_id: categoryId, notes, is_fixed: isFixed, template_id: templateId,
        expense_type: 'compartido', payment_account_id: null,
        paid_by: paidBy, created_by: currentUser.id,
      };
      let savedId = expenseId;
      if (expenseId) {
        const { error } = await sb.from('expenses').update(payload).eq('id', expenseId);
        if (error) throw new Error(error.message);
        await sb.from('expense_splits').delete().eq('expense_id', expenseId);
        const diff = diffExpense(before, payload, beforeParticipants, participants);
        logActivity('gastos', 'update', `Gasto: ${description} (${money(amount)})`, diff);
      } else {
        const { data, error } = await sb.from('expenses').insert(payload).select().single();
        if (error) throw new Error(error.message);
        savedId = data.id;
        logActivity('gastos', 'create', `Gasto: ${description} (${money(amount)})`, `Pagó: ${profileName(paidBy)}. Entre: ${participants.map(profileName).join(', ')}`);
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
  const exp = expensesCache.find(x => x.id === id);
  await sb.from('expenses').delete().eq('id', id);
  if (exp) logActivity('gastos', 'delete', `Gasto: ${exp.description} (${money(exp.amount)})`);
  $('#modal-expense').classList.add('hidden');
  await loadGastos();
});

// ----- Modal registrar pago -----
function populateSettlementToOptions() {
  const fromUser = myProfile?.is_admin ? $('#settlement-from-select').value : currentUser.id;
  $('#settlement-to').innerHTML = usersWithModuleAccess('gastos')
    .filter(p => p.user_id !== fromUser)
    .map(p => `<option value="${p.user_id}">${escapeHtml(p.display_name)}</option>`).join('');
}

$('#btn-add-settlement').addEventListener('click', () => {
  $('#form-settlement').reset();
  const eligible = usersWithModuleAccess('gastos');
  if (myProfile?.is_admin) {
    $('#settlement-from-display').classList.add('hidden');
    $('#settlement-from-select').classList.remove('hidden');
    $('#settlement-from-select').innerHTML = eligible.map(p =>
      `<option value="${p.user_id}">${escapeHtml(p.display_name)}${p.user_id === currentUser.id ? ' (vos)' : ''}</option>`
    ).join('');
    $('#settlement-from-select').value = currentUser.id;
  } else {
    $('#settlement-from-display').classList.remove('hidden');
    $('#settlement-from-select').classList.add('hidden');
    $('#settlement-from-display').textContent = profileName(currentUser.id) + ' (vos)';
  }
  populateSettlementToOptions();
  $('#settlement-date').value = todayStr();
  $('#modal-settlement').classList.remove('hidden');
});
$('#settlement-from-select').addEventListener('change', populateSettlementToOptions);
$('#btn-cancel-settlement').addEventListener('click', () => $('#modal-settlement').classList.add('hidden'));

$('#form-settlement').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const fromUser = myProfile?.is_admin ? $('#settlement-from-select').value : currentUser.id;
    const toUser = $('#settlement-to').value;
    // Admite "150000", "150.000" o "150,000" (separador de miles) además de decimales.
    const rawAmount = $('#settlement-amount').value.toString().trim();
    const amount = Number(rawAmount.replace(/\./g, '').replace(',', '.'));
    const settledDate = $('#settlement-date').value;
    const notes = $('#settlement-notes').value.trim() || null;

    if (!fromUser) { alert('No se pudo determinar quién paga. Cerrá y volvé a abrir el formulario.'); return; }
    if (!toUser) { alert('Elegí a quién se le paga.'); return; }
    if (fromUser === toUser) { alert('Elegí dos personas distintas.'); return; }
    if (!amount || amount <= 0 || Number.isNaN(amount)) { alert('Ingresá un monto válido, mayor a cero.'); return; }
    if (!settledDate) { alert('Elegí una fecha.'); return; }

    const { error } = await sb.from('settlements').insert({ from_user: fromUser, to_user: toUser, amount, settled_date: settledDate, notes });
    if (error) { alert('No se pudo guardar el pago: ' + error.message); return; }
    logActivity('gastos', 'create', `Pago: ${profileName(fromUser)} → ${profileName(toUser)} (${money(amount)})`);
    $('#modal-settlement').classList.add('hidden');
    await loadGastos();
  } catch (err) {
    console.error('Error registrando pago:', err);
    alert('No se pudo registrar el pago por un error inesperado: ' + (err?.message || err));
  }
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

  const { data: activity } = await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(500);
  activityLogCache = activity || [];
  populateActivityFilters();
  renderActivityLog();
}

// ----- Actividad (auditoría) -----
let activityLogCache = [];
const ACTIVITY_MODULE_LABELS = { gastos: '💰 Gastos', admin: '⚙️ Admin', medicamentos: '💊 Medicamentos', mercaderia: '🛒 Mercadería' };
const ACTIVITY_ACTION_LABELS = { create: 'creó', update: 'editó', delete: 'eliminó' };

function populateActivityFilters() {
  const userSel = $('#activity-filter-user');
  const userCurrent = userSel.value;
  userSel.innerHTML = '<option value="">Todos los usuarios</option>' +
    allProfiles.map(p => `<option value="${p.user_id}">${escapeHtml(p.display_name)}</option>`).join('');
  if (userCurrent) userSel.value = userCurrent;

  const modSel = $('#activity-filter-module');
  const modCurrent = modSel.value;
  const modulesPresent = [...new Set(activityLogCache.map(a => a.module))];
  modSel.innerHTML = '<option value="">Todos los módulos</option>' +
    modulesPresent.map(m => `<option value="${m}">${ACTIVITY_MODULE_LABELS[m] || m}</option>`).join('');
  if (modCurrent) modSel.value = modCurrent;

  const actSel = $('#activity-filter-action');
  const actCurrent = actSel.value;
  actSel.innerHTML = '<option value="">Todas las acciones</option>'
    + `<option value="create">Creó</option><option value="update">Editó</option><option value="delete">Eliminó</option>`;
  if (actCurrent) actSel.value = actCurrent;
}

function renderActivityLog() {
  const container = $('#activity-log-list');
  container.innerHTML = '';

  const userFilter = $('#activity-filter-user').value;
  const modFilter = $('#activity-filter-module').value;
  const actFilter = $('#activity-filter-action').value;
  const fromFilter = $('#activity-filter-from').value;
  const toFilter = $('#activity-filter-to').value;

  const filtered = activityLogCache.filter(a => {
    if (userFilter && a.user_id !== userFilter) return false;
    if (modFilter && a.module !== modFilter) return false;
    if (actFilter && a.action !== actFilter) return false;
    const day = a.created_at.slice(0, 10);
    if (fromFilter && day < fromFilter) return false;
    if (toFilter && day > toFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="hint">Sin actividad que coincida con el filtro.</p>';
    return;
  }
  filtered.forEach(a => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const when = new Date(a.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(profileName(a.user_id))}</strong> ${ACTIVITY_ACTION_LABELS[a.action] || a.action}
        <span class="activity-module-badge">${ACTIVITY_MODULE_LABELS[a.module] || a.module}</span>
        <br>${escapeHtml(a.description)}
        ${a.details ? `<div class="activity-details">${escapeHtml(a.details)}</div>` : ''}
      </div>
      <div class="when">${when}</div>
    `;
    container.appendChild(row);
  });
}

['activity-filter-user', 'activity-filter-module', 'activity-filter-action', 'activity-filter-from', 'activity-filter-to'].forEach(id => {
  $(`#${id}`).addEventListener('change', renderActivityLog);
});
$('#btn-clear-activity-filters').addEventListener('click', () => {
  $('#activity-filter-user').value = '';
  $('#activity-filter-module').value = '';
  $('#activity-filter-action').value = '';
  $('#activity-filter-from').value = '';
  $('#activity-filter-to').value = '';
  renderActivityLog();
});

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
      logActivity('admin', 'update', `Permisos de ${profileName(userId)} (${module})`, `${field === 'can_read' ? 'Ver' : 'Editar'}: ${chk.checked ? 'activado' : 'desactivado'}`);
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
    logActivity('admin', 'create', `Usuario nuevo: ${displayName} (${username})${isAdmin ? ' — administrador' : ''}`);
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
    // El "?v=" hace que cada versión nueva sea una URL distinta: así el
    // navegador nunca puede quedarse sirviendo una copia vieja en caché
    // sin darse cuenta de que hay una más nueva.
    navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' }).then((reg) => {
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
