/**
 * İlaç kutusu tanıma modülü — kamera + /api/medication/recognize
 */
window.MedicationRecognition = (() => {
    const API_BASE_URL = (window.CONFIG && CONFIG.API_BASE_URL) || "http://127.0.0.1:8000/api";
    const state = {
        medId: null,
        scheduleId: null,
        expectedName: "",
        stream: null,
    };

    let overlay = null;
    let videoEl = null;
    let previewImg = null;
    let statusEl = null;

    function speakTurkish(text) {
        if ("speechSynthesis" in window) {
            const msg = new SpeechSynthesisUtterance(text);
            msg.lang = "tr-TR";
            window.speechSynthesis.speak(msg);
        }
    }

    function ensureModal() {
        if (overlay) return;

        overlay = document.createElement("div");
        overlay.className = "med-rec-overlay";
        overlay.id = "medRecognitionOverlay";
        overlay.innerHTML = `
            <div class="med-rec-card">
                <h2>📷 İlaç Kutusu Tanıma</h2>
                <p class="med-rec-subtitle" id="medRecSubtitle">Kutuyu kameraya gösterin</p>
                <div class="med-rec-preview-wrap">
                    <video id="medRecVideo" class="med-rec-video" autoplay playsinline muted></video>
                    <img id="medRecPreviewImg" class="med-rec-preview-img" alt="Çekilen ilaç fotoğrafı" style="display:none;">
                </div>
                <div class="med-rec-status" id="medRecStatus"></div>
                <div class="med-rec-actions">
                    <button type="button" class="btn btn-success" id="medRecCaptureBtn">Fotoğraf Çek</button>
                    <button type="button" class="btn btn-neutral" id="medRecCloseBtn">Kapat</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        videoEl = document.getElementById("medRecVideo");
        previewImg = document.getElementById("medRecPreviewImg");
        statusEl = document.getElementById("medRecStatus");

        document.getElementById("medRecCaptureBtn").addEventListener("click", captureAndRecognize);
        document.getElementById("medRecCloseBtn").addEventListener("click", close);
    }

    function setStatus(message, isError = false) {
        if (!statusEl) return;
        statusEl.innerText = message;
        statusEl.style.color = isError ? "#B91C1C" : "#334155";
    }

    async function startCamera() {
        stopCamera();
        videoEl.style.display = "block";
        previewImg.style.display = "none";

        try {
            state.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
                audio: false,
            });
            videoEl.srcObject = state.stream;
            setStatus("Kamera hazır. Kutuyu ortalayın ve fotoğraf çekin.");
        } catch (error) {
            console.error(error);
            setStatus("Kamera açılamadı. Dosya seçerek deneyin.", true);
            pickImageFromFile();
        }
    }

    function stopCamera() {
        if (state.stream) {
            state.stream.getTracks().forEach((track) => track.stop());
            state.stream = null;
        }
        if (videoEl) {
            videoEl.srcObject = null;
        }
    }

    function pickImageFromFile() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "environment";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            await recognizeBlob(file);
        };
        input.click();
    }

    async function captureAndRecognize() {
        if (!videoEl.videoWidth) {
            setStatus("Kamera henüz hazır değil.", true);
            return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoEl, 0, 0);

        canvas.toBlob(async (blob) => {
            if (!blob) {
                setStatus("Fotoğraf oluşturulamadı.", true);
                return;
            }

            previewImg.src = canvas.toDataURL("image/jpeg", 0.92);
            previewImg.style.display = "block";
            videoEl.style.display = "none";
            stopCamera();

            await recognizeBlob(blob, "photo.jpg");
        }, "image/jpeg", 0.92);
    }

    async function recognizeBlob(blob, filename = "medication.jpg") {
        setStatus("İlaç analiz ediliyor...");

        const formData = new FormData();
        formData.append("file", blob, filename);
        if (state.expectedName) {
            formData.append("expected_name", state.expectedName);
        }
        if (state.medId) {
            formData.append("medication_id", state.medId);
        }
        if (state.scheduleId) {
            formData.append("schedule_id", state.scheduleId);
        }

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            const response = await fetch(`${API_BASE_URL}/medication/recognize`, {
                method: "POST",
                body: formData,
                signal: controller.signal,
            });
            clearTimeout(timer);

            let data = {};
            try {
                data = await response.json();
            } catch (_) {
                data = {};
            }
            if (!response.ok) {
                const detail = data.detail || data.message || `Sunucu hatası (${response.status})`;
                throw new Error(typeof detail === "string" ? detail : "Tanıma başarısız");
            }

            if (data.agent_decision === "wrong_medication" || data.is_match === false) {
                const wrongMsg =
                    data.message
                    || `Yanlış ilaç. Beklenen: ${state.expectedName || "planlanan ilaç"}. `
                        + `Kamerada: ${data.recognized_med || "tanınamadı"}.`;
                setStatus(wrongMsg, true);
                speakTurkish(wrongMsg);
                alert(`⚠️ ${wrongMsg}`);
                return;
            }

            if (data.agent_decision === "taken" || data.is_match === true) {
                const okMsg = data.message || `Harika, doğru ilaç: ${data.recognized_med}`;
                setStatus(okMsg);
                speakTurkish(okMsg);
                alert(`✅ ${okMsg}`);
            } else if (!state.expectedName) {
                const infoMsg = data.message || `Tanınan ilaç: ${data.recognized_med}`;
                setStatus(infoMsg);
                speakTurkish(infoMsg);
                alert(`📷 ${infoMsg}`);
                if (typeof MedicationDefinitions !== "undefined" && state.medId) {
                    await MedicationDefinitions.markTaken(
                        state.medId,
                        state.scheduleId,
                        state.expectedName || data.recognized_med,
                        "camera"
                    );
                }
            }

            if (typeof MedicationDefinitions !== "undefined") {
                await MedicationDefinitions.refresh();
            }
            if (typeof currentMedAlert !== "undefined") {
                currentMedAlert = null;
            }

            close();
        } catch (error) {
            console.error(error);
            const msg = error?.name === "AbortError"
                ? "Tanıma zaman aşımına uğradı. Tekrar deneyin."
                : (error?.message || "Sunucuya bağlanılamadı veya tanıma hatası oluştu.");
            setStatus(msg, true);
            speakTurkish(msg);
            alert(msg);
        }
    }

    function open(medicationId, expectedNameStr = null, scheduleId = null) {
        ensureModal();

        state.medId = medicationId;
        state.scheduleId = scheduleId;
        state.expectedName = expectedNameStr || "";

        const subtitle = document.getElementById("medRecSubtitle");
        if (subtitle) {
            subtitle.innerText = state.expectedName
                ? `Beklenen ilaç: ${state.expectedName}`
                : "Kutuyu kameraya gösterin";
        }

        overlay.classList.add("active");
        startCamera();
    }

    function close() {
        stopCamera();
        if (overlay) {
            overlay.classList.remove("active");
        }
        setStatus("");
        state.medId = null;
        state.scheduleId = null;
        state.expectedName = "";
    }

    return { open, close };
})();
