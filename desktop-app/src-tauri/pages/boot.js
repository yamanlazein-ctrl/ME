// Boot / recovery page of the desktop shell. Polls `boot_status`; opens the ERP when ready.
(function () {
  "use strict";
  var invoke = function (cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  };
  var $ = function (id) {
    return document.getElementById(id);
  };

  var EXPLAIN = {
    KEYS_MISSING: [
      "ملف مفاتيح التثبيت مفقود",
      "توجد بيانات شركة لكن ملف المفاتيح غير موجود. لم يُنشأ مفتاح جديد تلقائياً حتى لا تضيع جلسات الدخول وبيانات الربط. إن كان لديك نسخة من مجلد keys فأعدها ثم أعد المحاولة.",
    ],
    KEYS_UNREADABLE: [
      "تعذّرت قراءة ملف المفاتيح",
      "ملف المفاتيح تالف أو يخص مستخدم Windows آخر. افتح البرنامج من حساب Windows نفسه الذي ثُبّت عليه، أو أعد تعيين المفاتيح (بيانات الشركة لا تتأثر؛ تحتاج لإعادة تسجيل الدخول وربط المزامنة).",
    ],
    DATA_MISSING: [
      "قاعدة البيانات غير موجودة",
      "هذا الجهاز استُخدم سابقاً لكن ملف قاعدة البيانات غير موجود. استعد نسخة احتياطية أو ابدأ شركة جديدة.",
    ],
    DATA_ID_MISMATCH: [
      "قاعدة البيانات لا تخص هذا التثبيت",
      "الملف الموجود يعود لشركة أخرى. استعد النسخة الصحيحة.",
    ],
    SCHEMA_TOO_NEW: [
      "البيانات من إصدار أحدث",
      "هذه البيانات فُتحت بإصدار أحدث من البرنامج. ثبّت الإصدار الأحدث، أو استعد النسخة المأخوذة قبل التحديث.",
    ],
    INTEGRITY_FAILED: [
      "قاعدة البيانات تالفة",
      "فشل فحص سلامة قاعدة البيانات. استعد آخر نسخة احتياطية سليمة.",
    ],
    META_MISSING: [
      "ملف قاعدة البيانات غير صالح",
      "الملف ليس قاعدة بيانات موتارد. استعد نسخة احتياطية.",
    ],
    MIGRATION_FAILED: [
      "تعذّر تحديث بنية قاعدة البيانات",
      "لم يكتمل تحديث بنية البيانات ولم يُفتح البرنامج عليها. بياناتك محفوظة: استعد النسخة المأخوذة قبل التحديث ثم ثبّت الإصدار السابق، أو أرسل السجلات للدعم.",
    ],
    SCHEMA_UNVERIFIED: [
      "تعذّر التحقق من بنية قاعدة البيانات",
      "بنية القاعدة لا تطابق هذا الإصدار. استعد النسخة المأخوذة قبل التحديث.",
    ],
    PRE_UPDATE_COPY_FAILED: [
      "تعذّر أخذ نسخة قبل التحديث",
      "لم يُفتح البرنامج الجديد على بياناتك لأن النسخة الوقائية لم تكتمل. تأكد من وجود مساحة كافية على القرص ثم أعد المحاولة.",
    ],
    SERVICE_STOPPED: [
      "توقف الخادم المحلي",
      "توقف الخادم المحلي عدة مرات. أعد المحاولة، وإن تكرر الأمر افتح السجلات وأرسلها للدعم.",
    ],
    LOCKED: [
      "البرنامج مفتوح مسبقاً",
      "بيانات البرنامج مستخدمة من نسخة أخرى مفتوحة. أغلقها ثم أعد المحاولة.",
    ],
    BACKEND_START_FAILED: [
      "ملفات البرنامج ناقصة",
      "أعد تشغيل برنامج التثبيت لإصلاح ملفات البرنامج. بياناتك لا تتأثر.",
    ],
  };
  var DEFAULT = [
    "تعذّر تشغيل البرنامج",
    "حدث خطأ أثناء فتح بيانات الشركة. أعد المحاولة أو استعد النسخة المأخوذة قبل التحديث.",
  ];

  function act(name, confirm) {
    $("msg").textContent = "";
    invoke("boot_action", { name: name, confirm: confirm || null })
      .then(function () {
        poll();
      })
      .catch(function (e) {
        $("msg").textContent = String(e);
      });
  }

  function button(label, hint, cls, onClick) {
    var b = document.createElement("button");
    b.className = cls || "";
    b.textContent = label;
    var s = document.createElement("small");
    s.textContent = hint;
    b.appendChild(s);
    b.addEventListener("click", onClick);
    $("actions").appendChild(b);
    return b;
  }

  function typed(label, hint, phrase, name) {
    var wrap = document.createElement("div");
    var box = document.createElement("div");
    box.className = "confirm";
    var input = document.createElement("input");
    input.placeholder = "اكتب: " + phrase;
    input.setAttribute("aria-label", "اكتب " + phrase + " للتأكيد");
    var go = document.createElement("button");
    go.className = "danger";
    go.textContent = "تأكيد";
    go.addEventListener("click", function () {
      act(name, input.value.trim());
    });
    box.appendChild(input);
    box.appendChild(go);
    var b = button(label, hint, "danger", function () {
      box.classList.toggle("open");
      input.focus();
    });
    $("actions").appendChild(wrap);
    wrap.appendChild(b);
    wrap.appendChild(box);
  }

  var shownCode = null;
  function renderRecovery(st) {
    if (shownCode === st.code + "|" + st.preUpdateAvailable) return;
    shownCode = st.code + "|" + st.preUpdateAvailable;
    var e = EXPLAIN[st.code] || DEFAULT;
    $("title").textContent = e[0];
    $("explain").textContent = e[1];
    $("detail").textContent = (st.code || "") + (st.detail ? " — " + st.detail : "");
    $("actions").innerHTML = "";
    button("إعادة المحاولة", "تشغيل البرنامج مجدداً على البيانات نفسها", "primary", function () {
      act("retry");
    });
    if (st.preUpdateAvailable) {
      button(
        "استعادة النسخة المأخوذة قبل التحديث",
        "يرجع البيانات كما كانت قبل آخر تحديث (الملفات الحالية تُحفظ جانباً)",
        "",
        function () {
          act("restore_pre_update");
        },
      );
    }
    button(
      "استعادة نسخة احتياطية…",
      "اختر ملف نسخة (.zip)؛ البيانات الحالية تُنقل جانباً ولا تُحذف",
      "",
      function () {
        act("restore_backup");
      },
    );
    if (st.code === "KEYS_UNREADABLE" || st.code === "KEYS_MISSING") {
      typed(
        "إعادة تعيين المفاتيح",
        "ينشئ مفاتيح جديدة؛ القديمة تُحفظ جانباً",
        "إعادة تعيين المفاتيح",
        "reset_keys",
      );
    } else {
      typed(
        "بدء شركة جديدة",
        "يبدأ بقاعدة فارغة؛ البيانات الحالية تُنقل جانباً ولا تُحذف",
        "بدء شركة جديدة",
        "start_new",
      );
    }
    button("فتح مجلد السجلات", "لإرسالها إلى الدعم الفني", "", function () {
      act("open_logs");
    });
    button("إغلاق البرنامج", "", "", function () {
      act("exit");
    });
  }

  function poll() {
    invoke("boot_status")
      .then(function (st) {
        // Version / data folder are diagnostics: filled only when the recovery screen is shown.
        if (st.phase === "recovery") {
          $("ver").textContent = st.appVersion;
          $("root").textContent = st.dataRoot;
        }
        if (st.phase === "ready") {
          // The company changed (factory reset / start new / restore): the old company's tokens,
          // licence and sync markers must not reach the new one (L-02). Done here, by the shell's own
          // page, so no caller of the reset can forget it.
          if (st.clearWebStorage) {
            try {
              localStorage.clear();
              sessionStorage.clear();
            } catch (e) {
              /* storage unavailable */
            }
            invoke("boot_action", { name: "storage_cleared", confirm: null })
              .catch(function () {})
              .then(function () {
                location.replace("/index.html");
              });
            return;
          }
          location.replace("/index.html");
          return;
        }
        $("starting").hidden = st.phase !== "starting";
        $("recovery").hidden = st.phase !== "recovery";
        // Normal startup keeps the brand + generic spinner; step names are internal and not shown.
        if (st.phase === "starting") {
          shownCode = null;
        } else renderRecovery(st);
        setTimeout(poll, st.phase === "starting" ? 300 : 1500);
      })
      .catch(function () {
        setTimeout(poll, 500);
      });
  }
  poll();
})();
