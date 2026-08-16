# بناء تطبيق Windows — Motard Fabrics Group ERP

## المتطلبات

1. **Windows 10/11** (أو cross-compile من Linux/Mac)
2. **Rust + Cargo** — `rustup` مع target `x86_64-pc-windows-msvc`
3. **Node.js 22+**
4. **Visual Studio Build Tools** (Windows C++ compiler)

## تثبيت الأدوات

```powershell
# Rust (على Windows)
Invoke-WebRequest -Uri https://win.rustup.rs -OutFile rustup-init.exe
.\rustup-init.exe -y

# Visual Studio Build Tools (C++ workload)
winget install Microsoft.VisualStudio.2022.BuildTools
# أو من: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
# حدد: Desktop development with C++

# Node.js
winget install OpenJS.NodeJS
```

## بناء المشروع

```powershell
# 1. انتقل لمجلد المشروع
cd desktop

# 2. تثبيت Node.js dependencies
npm install

# 3. تثبيت Rust dependencies
cd src-tauri
cargo fetch

# 4. بناء الملفات (تجميع frontend + Rust)
cd .. && npm run tauri:build
```

## مخرجات البناء

بعد النجاح، يوجد في `desktop/src-tauri/target/release/bundle/`:

| الملف | الوصف |
|---|---|
| `msi/*.msi` | Windows Installer (recommended) |
| `nsis/*.exe` | NSIS Installer (أخف) |
| `*.exe` | ملف تنفيذي مباشر (portable) |

## خصائص التطبيق

- ✅ ربط الترخيص بـ 3 أجهزة
- ✅ تجربة 14 يوم بدون ترخيص
- ✅ فترة سماح 7 أيام بعد انتهاء الترخيص
- ✅ فحص ذاتي (fingerprint) CPU + MAC + hostname
- ✅ عربي + إنجليزي
- ✅ Auto-update (قابل للتفعيل)

## نشر التطبيق

### الطريقة 1: MSI Installer (موصى بها)

```powershell
# التطبيق يُثبّت في Program Files مع اختصار Start Menu
# يدعم إلغاء التثبيت من Control Panel
```

### الطريقة 2: Portable EXE

```powershell
# نسخ الملف .exe فقط + مجلد المشروع كاملاً
# يعمل من USB أو أي مجلد
```

### الطريقة 3: تثبيت صامت (Silent)

```powershell
# MSI صامت (للشركات)
msiexec /i MotardFabricsERP-1.0.0.msi /quiet /norestart
```

## تعديلات مطلوبة قبل البناء

### 1. أيقونة التطبيق

استبدل `desktop/src-tauri/icons/icon.png` بأيقونة بمقاسات متعددة:
- `icon.png` (512x512)
- `icon.ico` (16, 32, 48, 128, 256 — Windows)
- `icon.icns` (Apple — اختياري)

### 2. تخصيص Installer

عدّل `desktop/src-tauri/tauri.conf.json`:
```json
{
  "bundle": {
    "windows": {
      "wix": {
        "language": ["ar-SA", "en-US"],
        "license": "../../LICENSE.txt"
      }
    }
  }
}
```

### 3. توقيع الكود (Code Signing) — اختياري لكن موصى

```powershell
# سجل الشهادة (من أي CA أو Let's Encrypt)
signtool sign /f certificate.pfx /p password /t http://timestamp.digicert.com MotardFabricsERP.exe
```

## استكشاف الأخطاء

### مشكلة: `tauri` لا يُنشئ نافذة
```powershell
# تأكد من أن backend يعمل على localhost:8083
# أو عدّل proxy في vite.config.ts
```

### مشكلة: رقم ترخيص غير صحيح
```powershell
# التطبيق يحتاج اتصال بالخادم للتفعيل
# استخدم license key من admin-dashboard: http://localhost:5173
```

## التحديث التلقائي (Auto-Update)

لتفعيل التحديث التلقائي:
1. استضف ملف `latest.json` على خادمك
2. عدّل `tauri.conf.json`:
```json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": ["https://yourdomain.com/latest.json"]
    }
  }
}
```
