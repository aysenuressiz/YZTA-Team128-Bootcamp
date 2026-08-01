/**
 * Giriş sayfası yardımcıları — tek iletişim kutusu + yüz paneli + tarama ilerlemesi.
 */
let _faceScanCreepTimer = null;
let _faceScanPercent = 0;

function parseLoginContact(raw) {
    const value = String(raw || "").trim();
    if (!value) return { phone: null, email: null };
    if (value.includes("@")) {
        return { phone: null, email: value.toLowerCase() };
    }
    const digits = value.replace(/\D+/g, "");
    return { phone: digits || null, email: null };
}

function formatTrPhoneDisplay(raw) {
    const digits = String(raw || "").replace(/\D+/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    if (digits.length <= 8) {
        return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;
}

function bindContactMask(input) {
    if (!input) return;
    input.addEventListener("input", () => {
        const raw = input.value;
        if (raw.includes("@") || /[a-zA-Z]/.test(raw)) return;
        input.value = formatTrPhoneDisplay(raw);
    });
}

function setLoginStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-error", "is-ok", "is-wait");
    if (kind) el.classList.add(`is-${kind}`);
}

function stopFaceScanCreep() {
    if (_faceScanCreepTimer) {
        clearInterval(_faceScanCreepTimer);
        _faceScanCreepTimer = null;
    }
}

function setFaceScanProgress(percent, label, opts = {}) {
    const overlay = document.getElementById("face-scan-overlay");
    const water = document.getElementById("face-scan-water");
    const pctEl = document.getElementById("face-scan-pct");
    const labelEl = document.getElementById("face-scan-label");
    const stage = document.getElementById("cam-stage");
    if (!overlay) return;

    const next = Math.max(0, Math.min(100, Math.round(percent)));
    // İlerleme geri gitmesin (sonuç aşaması hariç reset için force)
    if (!opts.force && next < _faceScanPercent && next < 100) {
        return;
    }
    _faceScanPercent = next;

    overlay.hidden = false;
    overlay.classList.toggle("is-done", Boolean(opts.done));
    overlay.classList.toggle("is-fail", Boolean(opts.fail));
    if (stage) stage.classList.add("is-scanning");
    if (water) water.style.setProperty("--fill", `${next}%`);
    if (pctEl) pctEl.textContent = `${next}%`;
    if (labelEl && label) labelEl.textContent = label;
}

function hideFaceScanProgress() {
    stopFaceScanCreep();
    _faceScanPercent = 0;
    const overlay = document.getElementById("face-scan-overlay");
    const water = document.getElementById("face-scan-water");
    const stage = document.getElementById("cam-stage");
    if (overlay) {
        overlay.hidden = true;
        overlay.classList.remove("is-done", "is-fail");
    }
    if (water) water.style.setProperty("--fill", "0%");
    if (stage) stage.classList.remove("is-scanning");
    const pctEl = document.getElementById("face-scan-pct");
    if (pctEl) pctEl.textContent = "0%";
}

/**
 * Sunucu analizi sürerken: gerçek yanıt gelene kadar %92'ye asymptotic yaklaş.
 * %100 yalnızca sonuç geldiğinde set edilir.
 */
function startFaceScanCreep(fromPercent) {
    stopFaceScanCreep();
    const start = Math.max(fromPercent || _faceScanPercent, 40);
    const startedAt = Date.now();
    const cap = 92;
    const expectedMs = 12000;

    _faceScanCreepTimer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        // 1 - e^(-t/T) → hızlı başlar, 92'ye asymptotik yaklaşır
        const t = elapsed / expectedMs;
        const eased = start + (cap - start) * (1 - Math.exp(-2.2 * t));
        const pct = Math.min(cap, eased);
        setFaceScanProgress(pct, "Yüz analizi yapılıyor…");
        if (pct >= cap - 0.2) stopFaceScanCreep();
    }, 120);
}

function postFaceLoginWithProgress(base64Image) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE_URL}/auth/face-login`);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.responseType = "json";

        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            const ratio = event.loaded / Math.max(event.total, 1);
            // Gönderim: %35 → %48
            setFaceScanProgress(35 + ratio * 13, "Görüntü gönderiliyor…");
        };

        xhr.upload.onload = () => {
            setFaceScanProgress(50, "Sunucu yüzü inceliyor…");
            startFaceScanCreep(50);
        };

        xhr.onerror = () => {
            stopFaceScanCreep();
            reject(new Error("network"));
        };

        xhr.onload = () => {
            stopFaceScanCreep();
            let data = xhr.response;
            if (typeof data === "string") {
                try {
                    data = JSON.parse(data);
                } catch (_) {
                    data = {};
                }
            }
            if (!data || typeof data !== "object") data = {};
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
        };

        setFaceScanProgress(35, "Sunucuya gönderiliyor…");
        xhr.send(JSON.stringify({ image_data: base64Image }));
    });
}

function toggleFaceLoginPanel() {
    const panel = document.getElementById("face-login-panel");
    if (!panel) return;
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    if (willOpen) {
        hideFaceScanProgress();
        setLoginStatus(document.getElementById("face-status"), "Kamerayı açın, sonra yüzünüzü tarayın.", "wait");
    } else {
        hideFaceScanProgress();
        if (typeof stopWebcam === "function") stopWebcam();
        const video = document.getElementById("webcam");
        if (video) video.classList.remove("is-on");
        setLoginStatus(document.getElementById("face-status"), "Kamera kapalı.", null);
    }
}

function bootLoginPage() {
    if (!document.querySelector(".login-page") && !document.getElementById("elderly-login-form")) {
        return;
    }
    bindContactMask(document.getElementById("elderly-login-contact"));
    bindContactMask(document.getElementById("family-login-contact"));
    window.parseLoginContact = parseLoginContact;
    window.toggleFaceLoginPanel = toggleFaceLoginPanel;
    window.setLoginStatus = setLoginStatus;
    window.setFaceScanProgress = setFaceScanProgress;
    window.hideFaceScanProgress = hideFaceScanProgress;
    window.startFaceScanCreep = startFaceScanCreep;
    window.stopFaceScanCreep = stopFaceScanCreep;
    window.postFaceLoginWithProgress = postFaceLoginWithProgress;
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootLoginPage);
} else {
    bootLoginPage();
}
