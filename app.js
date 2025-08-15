// Utility: Register Service Worker & Push
function registerPush() {
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array('BOqS9zLT-USQBdiBka2zgy--Qi0PKO2xFiGRQdio2NF7-CJdd6WKVgu206ukLXGQPudR7NnF7yvkBteGIJ23Ov8')
          }).then(sub => {
            window.donorPushSubscription = sub.toJSON();
          });
        }
      });
    });
  }
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Show/hide modals for forms
window.showDonorForm = () => { document.getElementById('donorModal').style.display = 'block'; };
window.closeDonorForm = () => { document.getElementById('donorModal').style.display = 'none'; };
window.showReceiverForm = () => { document.getElementById('receiverModal').style.display = 'block'; };
window.closeReceiverForm = () => { document.getElementById('receiverModal').style.display = 'none'; };

// UX helpers
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.background = type === 'error' ? '#c62828' : type === 'success' ? '#2e7d32' : '#263238';
  toast.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 2500);
}
function setLoading(isLoading) {
  const loader = document.getElementById('loader');
  if (!loader) return;
  loader.style.display = isLoading ? 'grid' : 'none';
}

// Load stats for dashboard
async function loadStats() {
  try {
    const statsRes = await fetch('/api/stats');
    const donorsCountEl = document.getElementById('donorsCount');
    const requestsCountEl = document.getElementById('requestsCount');
    if (statsRes.ok) {
      const stats = await statsRes.json();
      if (donorsCountEl) donorsCountEl.textContent = stats.donorsCount ?? '-';
      if (requestsCountEl) requestsCountEl.textContent = stats.openRequestsCount ?? '-';
      return;
    }
    // Fallback to fetching full lists if /api/stats not available
    const [donorsRes, requestsRes] = await Promise.all([
      fetch('/api/donors'),
      fetch('/api/requests')
    ]);
    const donors = donorsRes.ok ? await donorsRes.json() : [];
    const requests = requestsRes.ok ? await requestsRes.json() : [];
    if (donorsCountEl) donorsCountEl.textContent = donors.length;
    if (requestsCountEl) requestsCountEl.textContent = requests.filter(r => r.status !== 'accepted').length;
  } catch {}
}

// --- Donor Registration ---
document.getElementById('donorForm').onsubmit = async function(e) {
  e.preventDefault();
  setLoading(true);
  const donorData = {
    name: this.donorName.value,
    email: this.donorEmail?.value || undefined,
    bloodGroup: this.bloodGroup.value,
    phone: this.donorPhone.value,
    location: this.donorLocation.value,
    notificationsEnabled: this.enableNotifications?.checked,
    registeredAt: new Date().toISOString(),
    isAvailable: true,
    pushSubscription: window.donorPushSubscription || null,
  };
  const res = await fetch('/api/donors', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(donorData)
  });
  const data = await res.json();
  setLoading(false);
  if (res.ok) {
    closeDonorForm();
    openSuccessModal('Registration Complete', 'Thank you for registering as a donor. You will be notified when someone nearby needs your blood group.');
    loadStats();
  } else {
    showToast(data.message || 'Error', 'error');
  }
};
// --- Request Blood ---
document.getElementById('receiverForm').onsubmit = async function(e) {
  e.preventDefault();
  setLoading(true);
  const reqData = {
    requesterName: this.receiverName.value,
    email: this.receiverEmail.value,
    bloodGroup: this.requiredBloodGroup.value,
    phone: this.receiverPhone.value,
    hospitalName: this.hospitalName.value,
    hospitalLocation: this.hospitalLocation.value,
    urgency: this.urgency.value,
    notes: this.notes.value,
    requestedAt: new Date().toISOString(),
    status: 'pending',
  };
  const res = await fetch('/api/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqData)
  });
  const data = await res.json();
  setLoading(false);
  if (res.ok) {
    closeReceiverForm();
    const codeMsg = data && data.manageCode ? `\n\nSave this 6-digit code: ${data.manageCode}. You'll need it to mark your request as received.` : '';
    openSuccessModal('Request Submitted', `Your blood request has been submitted. We are notifying compatible donors now.${codeMsg}`);
    pollRequestStatus(data._id);
    loadStats();
    loadRequests();
  } else {
    showToast(data.message || 'Error', 'error');
  }
};
// --- Poll for match ---
function pollRequestStatus(requestId) {
  const pollInfo = document.getElementById('pollInfo');
  const countdownEl = document.getElementById('pollCountdown');
  if (pollInfo) pollInfo.style.display = 'block';

  const POLL_INTERVAL = 5000;
  let remaining = POLL_INTERVAL / 1000;
  if (countdownEl) countdownEl.textContent = String(remaining);

  const tick = () => {
    remaining -= 1;
    if (countdownEl) countdownEl.textContent = String(Math.max(remaining, 0));
    if (remaining <= 0) remaining = POLL_INTERVAL / 1000;
  };
  const countdownTimer = setInterval(tick, 1000);

  const interval = setInterval(() => {
    fetch(`/api/requests/${requestId}`)
      .then(res => res.json())
      .then(request => {
        if (request.status === 'accepted' && request.donorDetails) {
          clearInterval(interval);
          clearInterval(countdownTimer);
          if (pollInfo) pollInfo.style.display = 'none';
          openSuccessModal('Donor Found', `Donor: ${request.donorDetails.name}, ${request.donorDetails.phone}`);
          fetchMessages(requestId);
        }
      })
      .catch(() => {});
  }, POLL_INTERVAL);
}
// --- In-app message feed ---
function fetchMessages(receiverId) {
  fetch(`/api/messages/${receiverId}`)
    .then(res => res.json())
    .then(msgs => {
      const feed = document.getElementById('messageFeed');
      if (!feed) return;
      feed.innerHTML = msgs.map(msg =>
        `<div><b>${msg.sender}:</b> ${msg.content} <i>${new Date(msg.sentAt).toLocaleString()}</i></div>`
      ).join('');
    });
}

registerPush();
loadStats();

// Load and render live requests
let __allRequestsCache = [];
async function loadRequests() {
  try {
    const res = await fetch('/api/requests');
    if (!res.ok) return;
    const all = await res.json();
    __allRequestsCache = all;
    const pending = all.filter(r => r.status !== 'accepted');
    const list = document.getElementById('requestsList');
    if (!list) return;
    list.innerHTML = pending.map(r => {
      const urgencyClass = r.urgency === 'critical' ? 'critical' : r.urgency === 'urgent' ? 'urgent' : 'normal';
      const phone = r.phone ? `<a class=\"call\" href=\"tel:${r.phone}\">Call</a>` : '';
      const email = r.email ? `<a class=\"email\" href=\"mailto:${r.email}?subject=Blood%20donation%20(${r.bloodGroup})\">Email</a>` : '';
      const map = r.hospitalLocation ? `<a class=\"map\" target=\"_blank\" href=\"https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.hospitalLocation)}\">Map</a>` : '';
      const manageBtn = r._id ? `<button class=\"btn\" onclick=\"resolveRequest('${r._id}')\">Mark Received</button>` : '';
      const codeBtn = r._id ? `<button class=\"btn btn-secondary\" onclick=\"revealCode('${r._id}')\">Show Code</button>` : '';
      return `
        <div class=\"request-card\">
          <div class=\"request-header\">
            <div class=\"request-title\">${r.bloodGroup || ''} needed</div>
            <span class=\"badge ${urgencyClass}\">${r.urgency || 'normal'}</span>
          </div>
          <div class=\"request-meta\">
            ${r.requesterName || 'Unknown'} — ${r.hospitalName || ''}
          </div>
          <div class=\"request-actions\">
            ${phone} ${email} ${map} ${manageBtn} ${codeBtn}
          </div>
        </div>`;
    }).join('');
  } catch {}
}

loadRequests();

// Filters
function renderRequestsFiltered() {
  const list = document.getElementById('requestsList');
  if (!list) return;
  const group = (document.getElementById('filterGroup')?.value || '').trim();
  const loc = (document.getElementById('filterLocation')?.value || '').trim().toLowerCase();
  const filtered = (__allRequestsCache || [])
    .filter(r => r.status !== 'accepted')
    .filter(r => !group || r.bloodGroup === group)
    .filter(r => !loc || `${r.hospitalLocation || ''} ${r.hospitalName || ''}`.toLowerCase().includes(loc));
  list.innerHTML = filtered.map(r => {
    const urgencyClass = r.urgency === 'critical' ? 'critical' : r.urgency === 'urgent' ? 'urgent' : 'normal';
    const phone = r.phone ? `<a class=\"call\" href=\"tel:${r.phone}\">Call</a>` : '';
    const email = r.email ? `<a class=\"email\" href=\"mailto:${r.email}?subject=Blood%20donation%20(${r.bloodGroup})\">Email</a>` : '';
    const map = r.hospitalLocation ? `<a class=\"map\" target=\"_blank\" href=\"https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.hospitalLocation)}\">Map</a>` : '';
    const manageBtn = r._id ? `<button class=\"btn\" onclick=\"resolveRequest('${r._id}')\">Mark Received</button>` : '';
    const codeBtn = r._id ? `<button class=\"btn btn-secondary\" onclick=\"revealCode('${r._id}')\">Show Code</button>` : '';
    return `
      <div class=\"request-card\">
        <div class=\"request-header\">
          <div class=\"request-title\">${r.bloodGroup || ''} needed</div>
          <span class=\"badge ${urgencyClass}\">${r.urgency || 'normal'}</span>
        </div>
        <div class=\"request-meta\">
          ${r.requesterName || 'Unknown'} — ${r.hospitalName || ''}
        </div>
        <div class=\"request-actions\">
          ${phone} ${email} ${map} ${manageBtn} ${codeBtn}
        </div>
      </div>`;
  }).join('');
}

// Resolve request (mark as received)
async function resolveRequest(requestId) {
  const useCode = confirm('Do you want to confirm with a 6-digit code? Click Cancel to verify with email & phone.');
  let body = {};
  if (useCode) {
    const code = prompt('Enter the 6-digit code you received when submitting the request:');
    if (!code) return;
    body.manageCode = code.trim();
  } else {
    const email = prompt('Enter the email used in the request:');
    const phone = prompt('Enter the phone used in the request:');
    if (!email || !phone) return;
    body.email = email.trim();
    body.phone = phone.trim();
  }
  try {
    const res = await fetch(`/api/requests/${requestId}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Marked as received. Thank you!', 'success');
      loadRequests();
      loadStats();
    } else {
      showToast(data.message || 'Unable to mark as received', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  }
}

// Reveal code (requires email+phone)
async function revealCode(requestId) {
  const email = prompt('Enter the email used in the request:');
  const phone = prompt('Enter the phone used in the request:');
  if (!email || !phone) return;
  try {
    const res = await fetch(`/api/requests/${requestId}/reveal-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), phone: phone.trim() })
    });
    const data = await res.json();
    if (res.ok && data.manageCode) {
      openSuccessModal('Your Management Code', `Use this code to mark the request as received: ${data.manageCode}`);
    } else {
      showToast(data.message || 'Unable to reveal code', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  }
}

function applyRequestFilters() {
  renderRequestsFiltered();
}
function clearRequestFilters() {
  const g = document.getElementById('filterGroup');
  const l = document.getElementById('filterLocation');
  if (g) g.value = '';
  if (l) l.value = '';
  renderRequestsFiltered();
}

// Location helper
function getCurrentLocation(context) {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported', 'error');
    return;
  }
  setLoading(true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const coords = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      if (context === 'donor') {
        const input = document.getElementById('donorLocation');
        if (input) input.value = coords;
      } else if (context === 'receiver') {
        const input = document.getElementById('hospitalLocation');
        if (input) input.value = coords;
      }
      setLoading(false);
      showToast('Location added', 'success');
    },
    () => { setLoading(false); showToast('Unable to fetch location', 'error'); }
  );
}

// Success modal helpers
function openSuccessModal(title, message) {
  const modal = document.getElementById('successModal');
  const t = document.getElementById('successTitle');
  const m = document.getElementById('successMessage');
  if (t) t.textContent = title;
  if (m) m.textContent = message;
  if (modal) modal.style.display = 'block';
}
function closeSuccessModal() {
  const modal = document.getElementById('successModal');
  if (modal) modal.style.display = 'none';
}