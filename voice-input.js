/* Ataya: optional Arabic voice dictation for data-entry fields.
   User activates microphone manually. Never records or stores raw audio in Ataya. */
(() => {
    "use strict";

    const Engine = window.SpeechRecognition || window.webkitSpeechRecognition;
    const fieldIds = [
        "benName", "benArea", "benPhone", "benFamilyCount",
        "benNeedPercent", "benCategory", "grantName", "grantDonor",
        "grantDocNo", "grantDefaultQuota", "grantUnitAmount", "grantDetails",
        "searchBen", "distSearchInput", "filterReportSearchName", "repAddBenSearch",
        "atayaCategorySearchDist", "atayaCategorySearchReport"
    ];
    let active = null;
    let localArabicAvailable = false;
    let remoteVoiceApproved = false;

    // Prefer local recognition when the browser already has an Arabic language pack.
    if (Engine && typeof Engine.available === "function") {
        Promise.resolve(Engine.available({ langs: ["ar-SA"], processLocally: true }))
            .then(result => { localArabicAvailable = result === "available"; })
            .catch(() => {});
    }

    const digitWords = {
        "صفر": "0", "واحد": "1", "واحده": "1", "اثنين": "2",
        "اثنان": "2", "اتنين": "2", "ثلاثه": "3", "ثلاث": "3",
        "اربعه": "4", "اربع": "4", "خمسه": "5", "خمس": "5",
        "سته": "6", "ست": "6", "سبعه": "7", "سبع": "7",
        "ثمانيه": "8", "ثمان": "8", "تسعه": "9", "تسع": "9"
    };
    const normalizeArabic = value => String(value || "")
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").trim();

    function spokenDigits(value) {
        const normalized = normalizeArabic(value)
            .replace(/[٠-٩۰-۹]/g, c => {
                const n = "٠١٢٣٤٥٦٧٨٩".indexOf(c);
                return n < 0 ? String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)) : String(n);
            })
            .replace(/٫/g, ".").replace(/[،,]/g, " ")
            .replace(/\s+/g, " ");
        if (/^[0-9 +.()-]+$/.test(normalized)) {
            return normalized.replace(/\s/g, "");
        }
        const words = normalized.split(/[\s،,]+/).filter(Boolean);
        if (!words.length) return null;
        const translated = words.map(w => digitWords[w] ?? (/^\d+$/.test(w) ? w : null));
        return translated.some(v => v === null) ? null : translated.join("");
    }

    function announce(message) {
        const status = document.getElementById("atayaVoiceStatus");
        if (!status) return;
        status.textContent = message;
        const shown = message;
        setTimeout(() => { if (status.textContent === shown) status.textContent = ""; }, 6000);
    }

    function labelFor(field) {
        const container = field.closest("div");
        const label = container?.querySelector("label") || container?.parentElement?.querySelector("label");
        return label?.textContent?.trim() || field.placeholder || "الحقل";
    }

    function resetActive() {
        if (!active) return;
        active.button.classList.remove("ataya-voice-listening");
        active.button.setAttribute("aria-pressed", "false");
        active.button.title = "البدء بالإملاء الصوتي";
        active = null;
    }

    function applyTranscript(field, spoken) {
        const kind = field.getAttribute("type")?.toLowerCase();
        let value = spoken.trim();
        if (kind === "number" || kind === "tel") {
            value = spokenDigits(value);
            if (value === null || (kind === "number" && !/^\d+(\.\d+)?$/.test(value)) ||
                (kind === "tel" && !/^\+?[\d()+-]+$/.test(value))) {
                announce("تعذر تحويل الرقم المنطوق إلى أرقام. يمكنك كتابته يدويًا.");
                return;
            }
            if (kind === "tel") {
                field.value = (field.value || "") + value;
            } else {
                field.value = value;
            }
        } else {
            const replaceQuery = ["benCategory", "searchBen", "distSearchInput",
                "filterReportSearchName", "repAddBenSearch",
                "atayaCategorySearchDist", "atayaCategorySearchReport"].includes(field.id);
            const before = replaceQuery ? "" : (field.value || "");
            field.value = before ? before.trimEnd() + " " + value : value;
        }
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.focus();
        announce("تم إدخال النص صوتيًا. راجع الكتابة قبل الحفظ.");
    }

    function startVoice(field, button) {
        if (!Engine) {
            announce("الإملاء الصوتي غير مدعوم في هذا المتصفح. استخدم الكتابة اليدوية.");
            return;
        }
        if (active) {
            const wasSame = active.button === button;
            try { active.recognition.abort(); } catch (_) {}
            resetActive();
            if (wasSame) return;
        }
        if (field.disabled || field.readOnly) return;
        if (!localArabicAvailable && !remoteVoiceApproved) {
            const permitted = confirm("الإملاء الصوتي قد يستخدم خدمة تعرف صوتي على الإنترنت تابعة للمتصفح، وقد تُرسل الكلمات المنطوقة إليها. لا تُملِ بيانات سرية أو حساسة. هل تريد تشغيل الميكروفون؟");
            if (!permitted) return;
            remoteVoiceApproved = true;
        }
        let recognition;
        try {
            recognition = new Engine();
            recognition.lang = "ar-SA";
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;
            if (localArabicAvailable && "processLocally" in recognition) recognition.processLocally = true;
            active = { field, button, recognition };
            recognition.onresult = event => {
                // Only accept final recognition results.
                const parts = [];
                for (let i = event.resultIndex || 0; i < event.results.length; i++) {
                    if (event.results[i].isFinal && event.results[i][0]?.transcript) {
                        parts.push(event.results[i][0].transcript);
                    }
                }
                if (parts.length) applyTranscript(field, parts.join(" "));
            };
            recognition.onerror = event => {
                const messages = {
                    "not-allowed": "يرجى السماح باستخدام الميكروفون من إعدادات المتصفح.",
                    "audio-capture": "تعذر الوصول إلى الميكروفون.",
                    "no-speech": "لم يتم سماع صوت واضح. حاول مرة أخرى.",
                    "network": "خدمة التعرف الصوتي تحتاج اتصالًا بالإنترنت في هذا المتصفح.",
                    "language-not-supported": "اللغة العربية غير متاحة للتعرف الصوتي المحلي على هذا الجهاز."
                };
                announce(messages[event.error] || "تعذر التعرف على الكلام. يمكنك الكتابة يدويًا.");
            };
            recognition.onend = () => {
                if (active?.recognition === recognition) resetActive();
            };
            recognition.start();
            button.classList.add("ataya-voice-listening");
            button.setAttribute("aria-pressed", "true");
            button.title = "إيقاف الاستماع";
            announce("الميكروفون يستمع الآن... تحدث باللغة العربية.");
        } catch (error) {
            resetActive();
            announce("تعذر تشغيل الإملاء الصوتي. تحقق من إذن الميكروفون والمتصفح.");
            console.warn("Voice recognition initialization failed:", error);
        }
    }

    function decorate(field) {
        if (!Engine || !field || field.dataset.atayaVoiceReady) return;
        if (!["TEXTAREA", "INPUT"].includes(field.tagName)) return;
        field.dataset.atayaVoiceReady = "1";
        const parent = field.parentNode;
        if (!parent) return;
        const wrapper = document.createElement("div");
        wrapper.className = "ataya-voice-wrapper";
        if (field.id === "searchBen") wrapper.classList.add("ataya-voice-inline");
        if (field.tagName === "TEXTAREA") wrapper.classList.add("ataya-voice-multiline");
        parent.insertBefore(wrapper, field);
        wrapper.appendChild(field);
        field.classList.add("ataya-voice-input");

        const button = document.createElement("button");
        button.type = "button";
        button.className = "ataya-voice-button";
        button.title = "البدء بالإملاء الصوتي";
        button.setAttribute("aria-label", "الإملاء الصوتي: " + labelFor(field));
        button.setAttribute("aria-pressed", "false");
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg>';
        button.addEventListener("click", () => startVoice(field, button));
        wrapper.appendChild(button);
    }

    function initialize() {
        if (!Engine) return;
        if (!document.getElementById("atayaVoiceStatus")) {
            const live = document.createElement("div");
            live.id = "atayaVoiceStatus";
            live.className = "ataya-voice-status";
            live.setAttribute("role", "status");
            live.setAttribute("aria-live", "polite");
            document.body.appendChild(live);
        }
        fieldIds.forEach(id => decorate(document.getElementById(id)));
    }
    window.AtayaVoice = { initialize };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
