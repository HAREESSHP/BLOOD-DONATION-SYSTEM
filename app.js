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
  
  // Get patient coordinates if available
  const patientLat = document.getElementById('patientLatitude')?.value;
  const patientLng = document.getElementById('patientLongitude')?.value;
  
  const reqData = {
    requesterName: this.receiverName.value,
    email: this.receiverEmail.value,
    bloodGroup: this.requiredBloodGroup.value,
    phone: this.receiverPhone.value,
    hospitalName: this.hospitalName.value,
    hospitalLocation: this.hospitalLocation.value,
    patientLatitude: patientLat ? parseFloat(patientLat) : undefined,
    patientLongitude: patientLng ? parseFloat(patientLng) : undefined,
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
    let codeMsg = data && data.manageCode ? `\n\nSave this 6-digit code: ${data.manageCode}. You'll need it to mark your request as received.` : '';
    
    // Show nearest blood banks if available
    if (data.nearestBloodBanks && data.nearestBloodBanks.length > 0) {
      const banksInfo = data.nearestBloodBanks.map((b, i) => `${i+1}. ${b.name} (${b.distance} km)`).join('\n');
      codeMsg += `\n\nNearest blood banks with ${data.bloodGroup}:\n${banksInfo}`;
    }
    
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
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const coords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      
      if (context === 'donor') {
        const input = document.getElementById('donorLocation');
        if (input) input.value = coords;
      } else if (context === 'receiver') {
        const input = document.getElementById('hospitalLocation');
        if (input) input.value = coords;
        // Also set hidden latitude and longitude fields
        const latInput = document.getElementById('patientLatitude');
        const lngInput = document.getElementById('patientLongitude');
        if (latInput) latInput.value = lat;
        if (lngInput) lngInput.value = lng;
      }
      setLoading(false);
      showToast('Location added', 'success');
      
      // Try to get address using Nominatim
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
        .then(res => res.json())
        .then(data => {
          if (data.display_name) {
            if (context === 'donor') {
              const input = document.getElementById('donorLocation');
              if (input) input.value = data.display_name;
            } else if (context === 'receiver') {
              const input = document.getElementById('hospitalLocation');
              if (input) input.value = data.display_name;
            }
          }
        })
        .catch(() => {});
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

// ==================== Blood Bank Search Feature (Leaflet.js + OpenStreetMap) ====================

let userLocation = null;
let searchRadius = 10; // Default 10km
let selectedBloodGroup = null;
let leafletMap = null;
let markers = [];
let routingControl = null;

// Show search blood bank modal
function showSearchBloodBank() {
  console.log('showSearchBloodBank called');
  const modal = document.getElementById('searchBloodBankModal');
  if (modal) {
    modal.style.display = 'block';
    console.log('Search modal opened');
  } else {
    console.error('Search modal not found!');
  }
  // Reset state
  userLocation = null;
  selectedBloodGroup = null;
  document.getElementById('locationStatus').style.display = 'none';
  document.getElementById('manualLocation').value = '';
  document.querySelectorAll('.blood-group-btn').forEach(btn => btn.classList.remove('active'));
}

function closeSearchBloodBank() {
  document.getElementById('searchBloodBankModal').style.display = 'none';
}

// Select blood group for search
function selectBloodGroup(group) {
  selectedBloodGroup = group;
  document.querySelectorAll('.blood-group-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.blood-group-btn[data-group="${group}"]`)?.classList.add('active');
}

// Use current GPS location
function useCurrentLocation() {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser', 'error');
    return;
  }
  
  setLoading(true);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      
      setLoading(false);
      document.getElementById('locationText').textContent = 
        `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}`;
      document.getElementById('locationStatus').style.display = 'flex';
      showToast('Location detected successfully!', 'success');
      
      // Use Nominatim for reverse geocoding (free, OpenStreetMap-based)
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${userLocation.lat}&lon=${userLocation.lng}`)
        .then(res => res.json())
        .then(data => {
          if (data.display_name) {
            document.getElementById('locationText').textContent = data.display_name;
          }
        })
        .catch(() => {});
    },
    (error) => {
      setLoading(false);
      let message = 'Unable to get your location';
      if (error.code === 1) message = 'Location access denied. Please enable location permissions.';
      else if (error.code === 2) message = 'Location unavailable. Please try again.';
      else if (error.code === 3) message = 'Location request timed out. Please try again.';
      showToast(message, 'error');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// Handle manual location input
document.addEventListener('DOMContentLoaded', function() {
  const manualInput = document.getElementById('manualLocation');
  if (manualInput) {
    manualInput.addEventListener('change', function() {
      const address = this.value.trim();
      if (!address) return;
      
      // Check if input is coordinates (lat, lng format)
      const coordMatch = address.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
      if (coordMatch) {
        userLocation = {
          lat: parseFloat(coordMatch[1]),
          lng: parseFloat(coordMatch[2])
        };
        document.getElementById('locationText').textContent = 
          `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}`;
        document.getElementById('locationStatus').style.display = 'flex';
        showToast('Location set from coordinates!', 'success');
        return;
      }
      
      // Use Nominatim for geocoding (free, OpenStreetMap-based)
      setLoading(true);
      fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`)
        .then(res => res.json())
        .then(data => {
          setLoading(false);
          if (data && data.length > 0) {
            userLocation = {
              lat: parseFloat(data[0].lat),
              lng: parseFloat(data[0].lon)
            };
            document.getElementById('locationText').textContent = data[0].display_name;
            document.getElementById('locationStatus').style.display = 'flex';
            showToast('Location found!', 'success');
          } else {
            showToast('Could not find that location. Try entering coordinates (lat, lng).', 'error');
          }
        })
        .catch(() => {
          setLoading(false);
          showToast('Error searching for location. Try entering coordinates.', 'error');
        });
    });
  }
});

// Select radius
function selectRadius(radius) {
  searchRadius = radius;
  document.querySelectorAll('.radius-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.radius-btn[data-radius="${radius}"]`)?.classList.add('active');
}

// Search for blood banks using our backend API
function searchBloodBanks() {
  console.log('searchBloodBanks called');
  
  if (!selectedBloodGroup) {
    showToast('Please select a blood group first', 'error');
    return;
  }
  
  if (!userLocation) {
    showToast('Please set your location first', 'error');
    return;
  }
  
  console.log('Blood Group:', selectedBloodGroup);
  console.log('Location set:', userLocation);
  console.log('Search radius:', searchRadius);
  
  // Close search modal and open results modal
  closeSearchBloodBank();
  const resultsModal = document.getElementById('bloodBankResultsModal');
  
  if (!resultsModal) {
    console.error('Results modal not found!');
    showToast('Error: Results modal not found', 'error');
    return;
  }
  
  resultsModal.style.display = 'block';
  resultsModal.style.visibility = 'visible';
  resultsModal.style.opacity = '1';
  
  // Update header with blood group
  document.getElementById('searchedBloodGroup').textContent = selectedBloodGroup;
  
  // Show loading state
  document.getElementById('bloodBanksList').innerHTML = `
    <div style="text-align: center; padding: 3rem;">
      <div class="loading" style="width: 40px; height: 40px; border-width: 4px; border-top-color: #e74c3c;"></div>
      <p style="margin-top: 1rem; color: #7f8c8d;">Searching for blood banks with ${selectedBloodGroup} blood...</p>
    </div>
  `;
  document.getElementById('resultsCount').textContent = 'Searching...';
  
  // Call our backend API
  fetch('/api/search-blood', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bloodGroup: selectedBloodGroup,
      latitude: userLocation.lat,
      longitude: userLocation.lng,
      maxDistance: searchRadius
    })
  })
    .then(res => res.json())
    .then(data => {
      console.log('Search results:', data);
      if (data.allNearbyBanks && data.allNearbyBanks.length > 0) {
        initializeLeafletMap(data.allNearbyBanks, data.nearestBanks);
      } else {
        document.getElementById('bloodBanksList').innerHTML = `
          <div class="no-results">
            <i class="fas fa-search"></i>
            <p>No blood banks with ${selectedBloodGroup} blood found within ${searchRadius} km.</p>
            <p>Try increasing the search radius or selecting a different blood group.</p>
          </div>
        `;
        document.getElementById('resultsCount').textContent = '0 blood banks found';
        initializeLeafletMap([], []);
      }
    })
    .catch(err => {
      console.error('Search error:', err);
      document.getElementById('bloodBanksList').innerHTML = `
        <div class="no-results">
          <i class="fas fa-exclamation-triangle"></i>
          <p>Error searching for blood banks.</p>
          <p>Please try again later.</p>
        </div>
      `;
      document.getElementById('resultsCount').textContent = 'Error';
    });
}

// Initialize Leaflet map with OpenStreetMap
function initializeLeafletMap(allBanks, nearestBanks) {
  const mapContainer = document.getElementById('bloodBankMap');
  
  // Clear existing map if any
  if (leafletMap) {
    leafletMap.remove();
    leafletMap = null;
  }
  
  // Clear markers array
  markers = [];
  
  // Create map centered on user location
  leafletMap = L.map(mapContainer).setView([userLocation.lat, userLocation.lng], 13);
  
  // Add OpenStreetMap tile layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(leafletMap);
  
  // Add user location marker (blue)
  const userIcon = L.divIcon({
    className: 'user-marker',
    html: '<div style="background: #4285F4; width: 24px; height: 24px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
  
  L.marker([userLocation.lat, userLocation.lng], { icon: userIcon })
    .addTo(leafletMap)
    .bindPopup('<strong>Your Location</strong>')
    .openPopup();
  
  // Add radius circle
  L.circle([userLocation.lat, userLocation.lng], {
    radius: searchRadius * 1000,
    color: '#e74c3c',
    fillColor: '#e74c3c',
    fillOpacity: 0.1,
    weight: 2
  }).addTo(leafletMap);
  
  // Display results count
  document.getElementById('resultsCount').textContent = 
    `${allBanks.length} blood bank${allBanks.length !== 1 ? 's' : ''} found within ${searchRadius} km`;
  
  // Add markers for blood banks
  allBanks.forEach((bank, index) => {
    const isNearest = nearestBanks.some(nb => nb._id === bank._id);
    const markerColor = isNearest ? '#27ae60' : '#e74c3c'; // Green for top 3, red for others
    
    const bankIcon = L.divIcon({
      className: 'bank-marker',
      html: `<div style="background: ${markerColor}; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">${index + 1}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    
    const marker = L.marker([bank.latitude, bank.longitude], { icon: bankIcon })
      .addTo(leafletMap)
      .bindPopup(`
        <div style="min-width: 200px;">
          <h4 style="margin: 0 0 5px 0;">${bank.name}</h4>
          <p style="margin: 0 0 5px 0; color: #666; font-size: 12px;">${bank.address}</p>
          <p style="margin: 0; font-weight: bold; color: ${markerColor};">
            <i class="fas fa-tint"></i> ${bank.availableUnits} units of ${selectedBloodGroup}
          </p>
          <p style="margin: 5px 0 0 0; font-size: 12px;">
            <i class="fas fa-route"></i> ${bank.distance} km • ${bank.estimatedTime}
          </p>
        </div>
      `);
    
    markers.push(marker);
  });
  
  // Fit map bounds to show all markers
  if (allBanks.length > 0) {
    const bounds = L.latLngBounds([
      [userLocation.lat, userLocation.lng],
      ...allBanks.map(bank => [bank.latitude, bank.longitude])
    ]);
    leafletMap.fitBounds(bounds, { padding: [20, 20] });
  }
  
  // Render blood bank list
  renderBloodBankList(allBanks, nearestBanks);
  
  // Automatically show route to nearest bank
  if (nearestBanks.length > 0) {
    setTimeout(() => {
      showRouteToBank(nearestBanks[0]);
    }, 500);
  }
}

// Render blood bank list
function renderBloodBankList(allBanks, nearestBanks) {
  const listContainer = document.getElementById('bloodBanksList');
  
  listContainer.innerHTML = allBanks.map((bank, index) => {
    const isNearest = nearestBanks.some(nb => nb._id === bank._id);
    const nearestLabel = isNearest ? '<span class="nearest-badge">Top 3 Nearest</span>' : '';
    
    return `
      <div class="bb-card ${isNearest ? 'nearest' : ''}" onclick="showRouteToBank(${JSON.stringify(bank).replace(/"/g, '&quot;')})">
        <div class="bb-card-header">
          <span class="bb-index" style="background: ${isNearest ? '#27ae60' : '#e74c3c'}">${index + 1}</span>
          <div class="bb-info">
            <h4>${bank.name} ${nearestLabel}</h4>
            <p class="bb-address"><i class="fas fa-map-marker-alt"></i> ${bank.address}</p>
          </div>
        </div>
        <div class="bb-card-body">
          <div class="inventory-badge">
            <i class="fas fa-tint"></i> ${bank.availableUnits} units of ${selectedBloodGroup}
          </div>
        </div>
        <div class="bb-card-footer">
          <span class="bb-distance"><i class="fas fa-route"></i> ${bank.distance} km</span>
          <span class="bb-time"><i class="fas fa-clock"></i> ${bank.estimatedTime}</span>
        </div>
        <div class="bb-actions">
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); showRouteToBank(${JSON.stringify(bank).replace(/"/g, '&quot;')})">
            <i class="fas fa-directions"></i> Show Route
          </button>
          <a href="tel:${bank.contactNumber}" class="btn btn-sm btn-secondary" onclick="event.stopPropagation();">
            <i class="fas fa-phone"></i> Call
          </a>
        </div>
      </div>
    `;
  }).join('');
}

// Show route to a specific blood bank using Leaflet Routing Machine
function showRouteToBank(bank) {
  if (!leafletMap || !userLocation) return;
  
  // Remove existing routing control
  if (routingControl) {
    leafletMap.removeControl(routingControl);
  }
  
  // Create routing control
  routingControl = L.Routing.control({
    waypoints: [
      L.latLng(userLocation.lat, userLocation.lng),
      L.latLng(bank.latitude, bank.longitude)
    ],
    routeWhileDragging: false,
    showAlternatives: false,
    createMarker: function() { return null; }, // Don't create default markers
    lineOptions: {
      styles: [{ color: '#e74c3c', weight: 5, opacity: 0.8 }]
    },
    show: false // Don't show the itinerary panel
  }).addTo(leafletMap);
  
  // Listen for route calculation
  routingControl.on('routesfound', function(e) {
    const route = e.routes[0];
    const distance = (route.summary.totalDistance / 1000).toFixed(1);
    const time = Math.round(route.summary.totalTime / 60);
    
    // Show route info panel
    const routePanel = document.getElementById('routeInfoPanel');
    routePanel.style.display = 'block';
    document.getElementById('routeDetails').innerHTML = `
      <p><strong>${bank.name}</strong></p>
      <p><i class="fas fa-route"></i> Distance: ${distance} km</p>
      <p><i class="fas fa-clock"></i> Travel Time: ${time} min</p>
      <p><i class="fas fa-tint"></i> Available: ${bank.availableUnits} units of ${selectedBloodGroup}</p>
      <p><i class="fas fa-phone"></i> <a href="tel:${bank.contactNumber}">${bank.contactNumber}</a></p>
    `;
    
    showToast(`Route to ${bank.name}: ${distance} km, ~${time} min`, 'success');
  });
  
  routingControl.on('routingerror', function(e) {
    console.error('Routing error:', e);
    showToast('Could not calculate route. Showing straight line distance.', 'error');
    
    // Show straight line instead
    const routePanel = document.getElementById('routeInfoPanel');
    routePanel.style.display = 'block';
    document.getElementById('routeDetails').innerHTML = `
      <p><strong>${bank.name}</strong></p>
      <p><i class="fas fa-route"></i> Straight-line Distance: ${bank.distance} km</p>
      <p><i class="fas fa-clock"></i> Estimated Time: ${bank.estimatedTime}</p>
      <p><i class="fas fa-tint"></i> Available: ${bank.availableUnits} units of ${selectedBloodGroup}</p>
      <p><i class="fas fa-phone"></i> <a href="tel:${bank.contactNumber}">${bank.contactNumber}</a></p>
    `;
  });
  
  // Fit map to show route
  const bounds = L.latLngBounds([
    [userLocation.lat, userLocation.lng],
    [bank.latitude, bank.longitude]
  ]);
  leafletMap.fitBounds(bounds, { padding: [50, 50] });
}

// Calculate distance between two points (Haversine formula) - client-side for reference
function calculateDistance(point1, point2) {
  const R = 6371; // Earth's radius in km
  const dLat = (point2.lat - point1.lat) * Math.PI / 180;
  const dLon = (point2.lng - point1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Close blood bank results
function closeBloodBankResults() {
  document.getElementById('bloodBankResultsModal').style.display = 'none';
  document.getElementById('routeInfoPanel').style.display = 'none';
  // Clear routing control
  if (routingControl && leafletMap) {
    leafletMap.removeControl(routingControl);
    routingControl = null;
  }
}

// Refresh search
function refreshSearch() {
  searchBloodBanks();
}

// Seed blood banks on first load (for development)
async function seedBloodBanksIfNeeded() {
  try {
    const res = await fetch('/api/bloodbanks/seed', { method: 'POST' });
    const data = await res.json();
    console.log('Seed blood banks:', data);
  } catch (err) {
    console.log('Blood banks already exist or seed failed');
  }
}

// Call seed on page load
seedBloodBanksIfNeeded();