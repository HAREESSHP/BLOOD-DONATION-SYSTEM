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

// ==================== Blood Bank Search Feature ====================

let userLocation = null;
let searchRadius = 10; // Default 10km
let map = null;
let markers = [];
let directionsService = null;
let directionsRenderer = null;
let placesService = null;
let googleMapsLoaded = false;

// Handle Google Maps API loading error
window.gm_authFailure = function() {
  console.error('Google Maps authentication failed');
  googleMapsLoaded = false;
};

// Initialize Google Maps (called by API callback)
function initMap() {
  // Map will be initialized when needed
  googleMapsLoaded = true;
  console.log('Google Maps API loaded successfully');
}

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
  document.getElementById('locationStatus').style.display = 'none';
  document.getElementById('manualLocation').value = '';
}

function closeSearchBloodBank() {
  document.getElementById('searchBloodBankModal').style.display = 'none';
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
      
      // Check if Google Maps is loaded for reverse geocoding
      if (typeof google !== 'undefined' && googleMapsLoaded) {
        // Reverse geocode to get address
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: userLocation }, (results, status) => {
          setLoading(false);
          if (status === 'OK' && results[0]) {
            document.getElementById('locationText').textContent = results[0].formatted_address;
          } else {
            document.getElementById('locationText').textContent = 
              `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}`;
          }
          document.getElementById('locationStatus').style.display = 'flex';
          showToast('Location detected successfully!', 'success');
        });
      } else {
        // Google Maps not loaded, just show coordinates
        setLoading(false);
        document.getElementById('locationText').textContent = 
          `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}`;
        document.getElementById('locationStatus').style.display = 'flex';
        showToast('Location detected! (Address lookup unavailable)', 'success');
      }
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
      
      if (typeof google === 'undefined' || !googleMapsLoaded) {
        showToast('Google Maps is still loading. Please wait and try again.', 'error');
        return;
      }
      
      setLoading(true);
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address: address }, (results, status) => {
        setLoading(false);
        if (status === 'OK' && results[0]) {
          userLocation = {
            lat: results[0].geometry.location.lat(),
            lng: results[0].geometry.location.lng()
          };
          document.getElementById('locationText').textContent = results[0].formatted_address;
          document.getElementById('locationStatus').style.display = 'flex';
          showToast('Location found!', 'success');
        } else {
          showToast('Could not find that location. Please try again.', 'error');
        }
      });
    });
  }
});

// Select radius
function selectRadius(radius) {
  searchRadius = radius;
  document.querySelectorAll('.radius-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.radius-btn[data-radius="${radius}"]`)?.classList.add('active');
  document.getElementById('customRadius').value = '';
}

// Search for blood banks
function searchBloodBanks() {
  console.log('searchBloodBanks called');
  
  // Check for custom radius
  const customRadius = document.getElementById('customRadius').value;
  if (customRadius && parseInt(customRadius) > 0) {
    searchRadius = parseInt(customRadius);
  }
  
  if (!userLocation) {
    showToast('Please set your location first', 'error');
    return;
  }
  
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
  console.log('Results modal display set to block');
  
  // Show loading state
  document.getElementById('bloodBanksList').innerHTML = `
    <div style="text-align: center; padding: 3rem;">
      <div class="loading" style="width: 40px; height: 40px; border-width: 4px; border-top-color: #e74c3c;"></div>
      <p style="margin-top: 1rem; color: #7f8c8d;">Searching for blood banks...</p>
    </div>
  `;
  document.getElementById('resultsCount').textContent = 'Searching...';
  
  // Initialize map with a small delay to ensure modal is visible
  setTimeout(() => {
    initializeBloodBankMap();
  }, 100);
}

function initializeBloodBankMap() {
  const mapContainer = document.getElementById('bloodBankMap');
  
  // Check if Google Maps is loaded
  if (typeof google === 'undefined' || typeof google.maps === 'undefined') {
    document.getElementById('bloodBanksList').innerHTML = `
      <div class="no-results">
        <i class="fas fa-exclamation-triangle"></i>
        <p>Google Maps failed to load.</p>
        <p>Please check your internet connection and try again.</p>
      </div>
    `;
    document.getElementById('resultsCount').textContent = 'Error loading maps';
    return;
  }
  
  // Create map centered on user location
  map = new google.maps.Map(mapContainer, {
    center: userLocation,
    zoom: 13,
    styles: [
      { featureType: 'poi.medical', stylers: [{ visibility: 'on' }] },
      { featureType: 'poi.business', stylers: [{ visibility: 'off' }] }
    ]
  });
  
  // Add user location marker
  new google.maps.Marker({
    position: userLocation,
    map: map,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 12,
      fillColor: '#4285F4',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 3
    },
    title: 'Your Location'
  });
  
  // Draw radius circle
  new google.maps.Circle({
    map: map,
    center: userLocation,
    radius: searchRadius * 1000, // Convert km to meters
    fillColor: '#e74c3c',
    fillOpacity: 0.1,
    strokeColor: '#e74c3c',
    strokeOpacity: 0.5,
    strokeWeight: 2
  });
  
  // Initialize services
  placesService = new google.maps.places.PlacesService(map);
  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    map: map,
    suppressMarkers: false,
    polylineOptions: {
      strokeColor: '#e74c3c',
      strokeWeight: 5
    }
  });
  
  // Search for blood banks
  searchNearbyBloodBanks();
}

function searchNearbyBloodBanks() {
  const request = {
    location: userLocation,
    radius: searchRadius * 1000,
    keyword: 'blood bank'
  };
  
  // Clear previous markers
  markers.forEach(marker => marker.setMap(null));
  markers = [];
  
  placesService.nearbySearch(request, (results, status) => {
    if (status === google.maps.places.PlacesServiceStatus.OK) {
      displayBloodBankResults(results);
    } else {
      // Try alternative search with different keywords
      const altRequest = {
        location: userLocation,
        radius: searchRadius * 1000,
        keyword: 'blood donation center hospital blood'
      };
      
      placesService.nearbySearch(altRequest, (altResults, altStatus) => {
        if (altStatus === google.maps.places.PlacesServiceStatus.OK) {
          displayBloodBankResults(altResults);
        } else {
          document.getElementById('bloodBanksList').innerHTML = `
            <div class="no-results">
              <i class="fas fa-search"></i>
              <p>No blood banks found in this area.</p>
              <p>Try increasing the search radius.</p>
            </div>
          `;
          document.getElementById('resultsCount').textContent = '0 blood banks found';
        }
      });
    }
  });
}

function displayBloodBankResults(places) {
  const listContainer = document.getElementById('bloodBanksList');
  document.getElementById('resultsCount').textContent = `${places.length} blood banks found within ${searchRadius} km`;
  
  // Sort by distance
  places.sort((a, b) => {
    const distA = calculateDistance(userLocation, { lat: a.geometry.location.lat(), lng: a.geometry.location.lng() });
    const distB = calculateDistance(userLocation, { lat: b.geometry.location.lat(), lng: b.geometry.location.lng() });
    return distA - distB;
  });
  
  listContainer.innerHTML = places.map((place, index) => {
    const distance = calculateDistance(userLocation, {
      lat: place.geometry.location.lat(),
      lng: place.geometry.location.lng()
    });
    
    const rating = place.rating ? `<span class="bb-rating"><i class="fas fa-star"></i> ${place.rating}</span>` : '';
    const openNow = place.opening_hours?.open_now;
    const openStatus = openNow !== undefined 
      ? `<span class="bb-status ${openNow ? 'open' : 'closed'}">${openNow ? 'Open Now' : 'Closed'}</span>`
      : '';
    
    // Add marker to map
    const marker = new google.maps.Marker({
      position: place.geometry.location,
      map: map,
      icon: {
        url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
        scaledSize: new google.maps.Size(40, 40)
      },
      title: place.name,
      label: {
        text: String(index + 1),
        color: 'white',
        fontWeight: 'bold'
      }
    });
    
    // Info window
    const infoWindow = new google.maps.InfoWindow({
      content: `
        <div style="padding: 10px; max-width: 200px;">
          <h4 style="margin: 0 0 5px 0;">${place.name}</h4>
          <p style="margin: 0; color: #666; font-size: 12px;">${place.vicinity}</p>
          ${rating}
        </div>
      `
    });
    
    marker.addListener('click', () => {
      infoWindow.open(map, marker);
    });
    
    markers.push(marker);
    
    return `
      <div class="bb-card" onclick="showDirections(${place.geometry.location.lat()}, ${place.geometry.location.lng()}, '${place.name.replace(/'/g, "\\'")}')">
        <div class="bb-card-header">
          <span class="bb-index">${index + 1}</span>
          <div class="bb-info">
            <h4>${place.name}</h4>
            <p class="bb-address"><i class="fas fa-map-marker-alt"></i> ${place.vicinity}</p>
          </div>
        </div>
        <div class="bb-card-footer">
          <span class="bb-distance"><i class="fas fa-route"></i> ${distance.toFixed(1)} km</span>
          ${rating}
          ${openStatus}
        </div>
        <div class="bb-actions">
          <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); showDirections(${place.geometry.location.lat()}, ${place.geometry.location.lng()}, '${place.name.replace(/'/g, "\\'")}')">
            <i class="fas fa-directions"></i> Directions
          </button>
          <a href="https://www.google.com/maps/dir/?api=1&origin=${userLocation.lat},${userLocation.lng}&destination=${place.geometry.location.lat()},${place.geometry.location.lng()}" target="_blank" class="btn btn-sm btn-secondary" onclick="event.stopPropagation();">
            <i class="fas fa-external-link-alt"></i> Open in Maps
          </a>
        </div>
      </div>
    `;
  }).join('');
}

// Calculate distance between two points (Haversine formula)
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

// Show directions to a blood bank
function showDirections(destLat, destLng, placeName) {
  const destination = { lat: destLat, lng: destLng };
  
  const request = {
    origin: userLocation,
    destination: destination,
    travelMode: google.maps.TravelMode.DRIVING
  };
  
  directionsService.route(request, (result, status) => {
    if (status === google.maps.DirectionsStatus.OK) {
      directionsRenderer.setDirections(result);
      
      // Show route info
      const route = result.routes[0].legs[0];
      showToast(`${placeName}: ${route.distance.text}, ${route.duration.text}`, 'success');
      
      // Fit map to show entire route
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(userLocation);
      bounds.extend(destination);
      map.fitBounds(bounds);
    } else {
      showToast('Could not calculate directions', 'error');
    }
  });
}

// Close blood bank results
function closeBloodBankResults() {
  document.getElementById('bloodBankResultsModal').style.display = 'none';
  // Clear directions
  if (directionsRenderer) {
    directionsRenderer.setDirections({ routes: [] });
  }
}

// Refresh search
function refreshSearch() {
  searchNearbyBloodBanks();
}