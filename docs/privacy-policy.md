# Privacy Policy

**Vibe Music & Podcast Launcher**  
*Last updated: May 1, 2026*

---

## 1. Introduction

This Privacy Policy explains how Vibe Music & Podcast Launcher ("Vibe Launcher", "the App", "we", "us", or "our") handles information when you use our Android application. We are committed to protecting your privacy and ensuring transparency about our data practices.

This policy complies with:
- **European Union**: General Data Protection Regulation (GDPR)
- **United Kingdom**: UK GDPR and Data Protection Act 2018
- **United States**: California Consumer Privacy Act (CCPA/CPRA), Virginia Consumer Data Protection Act (VCDPA), Colorado Privacy Act (CPA)
- **Brazil**: Lei Geral de Proteção de Dados (LGPD)
- **Canada**: Personal Information Protection and Electronic Documents Act (PIPEDA)
- **Australia**: Privacy Act 1988
- **Japan**: Act on the Protection of Personal Information (APPI)
- **South Korea**: Personal Information Protection Act (PIPA)
- **Other jurisdictions**: We respect all applicable local data protection laws worldwide.

---

## 2. Data Controller

**Developer:** Andreas Delgaldo  
**Contact:** andreas.delgaldo@googlemail.com  
**Location:** Germany, European Union

For GDPR purposes, the developer is the data controller responsible for your personal data.

---

## 3. Data We Collect

### 3.1 We Do NOT Collect Personal Data

Vibe Launcher is designed with a **privacy-first architecture**. We do not collect, store, process, transmit, or share any personal data. Specifically:

| Data Type | Collected? | Details |
|-----------|:----------:|---------|
| Personal identifiers (name, email, phone) | ❌ No | Never collected |
| Location data | ❌ No | No GPS/location access |
| Financial information | ❌ No | No payment processing in-app |
| Contacts or address book | ❌ No | No access requested |
| Photos, videos, or camera | ❌ No | No access requested |
| Browsing history | ❌ No | No web browsing |
| Device identifiers (IMEI, advertising ID) | ❌ No | Never read or transmitted |
| Analytics or telemetry | ❌ No | No analytics SDKs |
| Crash reports | ❌ No | No crash reporting services |
| Usage statistics | ❌ No | Not transmitted to any server |
| Cookies or tracking pixels | ❌ No | No web views with tracking |

### 3.2 Data Stored Locally on Your Device

The following data is stored **exclusively on your device** and never leaves it:

- **App preferences** (theme, equalizer settings, DLNA device name, brightness schedule)
- **Music library index** (cached metadata from your local audio files)
- **Podcast subscriptions** (feed URLs, episode playback positions)
- **Liked tracks and playback history** (stored in local SharedPreferences)
- **Downloaded podcast episodes** (stored in app-specific storage)

This data is **not accessible** to us or any third party.

---

## 4. Permissions and Their Purpose

The App requests the following Android permissions solely for functionality:

| Permission | Purpose | Data Leaves Device? |
|-----------|---------|:-------------------:|
| `READ_MEDIA_AUDIO` | Access your local music files for playback | ❌ No |
| `INTERNET` | Stream podcasts, search iTunes podcast directory, DLNA network playback | See §5 |
| `ACCESS_WIFI_STATE` / `ACCESS_NETWORK_STATE` | Discover DLNA renderers on your local network | ❌ No |
| `CHANGE_WIFI_MULTICAST_STATE` | UPnP/SSDP device discovery protocol | ❌ No |
| `FOREGROUND_SERVICE` | Keep music playing in background | ❌ No |
| `POST_NOTIFICATIONS` | Show media playback controls in notification | ❌ No |
| `WRITE_SETTINGS` | Optional: automatic brightness based on time of day | ❌ No |
| `SET_WALLPAPER` | Optional: set generated wallpaper | ❌ No |
| `QUERY_ALL_PACKAGES` | Display installed apps in app drawer (launcher function) | ❌ No |
| `REQUEST_DELETE_PACKAGES` | Allow user to uninstall apps from launcher | ❌ No |

---

## 5. Network Communications

The App communicates over the network **only** for these purposes:

### 5.1 Podcast Streaming & Search
- **What:** HTTP requests to podcast RSS feed URLs and the iTunes Search API (`itunes.apple.com`)
- **Data sent:** Search query text (when searching for podcasts)
- **Data received:** Podcast metadata (title, author, episode list, artwork URLs)
- **No personal data** is included in these requests

### 5.2 DLNA/UPnP Streaming
- **What:** Local network communication with DLNA media renderers
- **Scope:** Exclusively within your local Wi-Fi network (LAN)
- **Data sent:** Audio stream data, playback control commands
- **No data leaves your local network**

### 5.3 No External Servers
We do **not** operate any servers. The App does not communicate with any server controlled by us. There is no backend, no cloud service, no user accounts.

---

## 6. Third-Party Services

The App does **not** integrate any third-party services that collect user data:

- ❌ No Google Analytics / Firebase Analytics
- ❌ No Facebook SDK
- ❌ No advertising networks or ad SDKs
- ❌ No crash reporting services (Crashlytics, Sentry, etc.)
- ❌ No social media SDKs
- ❌ No user authentication services

The only external API accessed is the **Apple iTunes Search API** for podcast discovery, which is subject to [Apple's Privacy Policy](https://www.apple.com/legal/privacy/).

---

## 7. Data Retention and Deletion

### 7.1 Retention
All app data is stored locally on your device for as long as the App is installed. We have no access to this data and cannot retain it.

### 7.2 Deletion
- **Uninstalling the App** permanently deletes all associated data from your device.
- You can clear app data at any time via Android Settings → Apps → Vibe Launcher → Clear Data.
- No residual data remains on any external server after uninstallation, because no data was ever transmitted.

---

## 8. Your Rights

### 8.1 Under GDPR (EU/EEA/UK)

Since we do not collect or process personal data, the following rights are satisfied by design:

- **Right of access** (Art. 15): No personal data exists to access.
- **Right to rectification** (Art. 16): No personal data exists to correct.
- **Right to erasure** (Art. 17): Uninstalling the App erases all local data.
- **Right to data portability** (Art. 20): No personal data is processed.
- **Right to object** (Art. 21): No profiling or automated decision-making occurs.
- **Right to restrict processing** (Art. 18): No processing of personal data occurs.

### 8.2 Under CCPA/CPRA (California, USA)

- We do **not sell** personal information.
- We do **not share** personal information for cross-context behavioral advertising.
- We do **not** collect personal information as defined by the CCPA.
- California residents have the right to know, delete, and opt-out — all satisfied by our zero-collection policy.

### 8.3 Under LGPD (Brazil)

- No personal data (dados pessoais) is collected or processed.
- The legal basis for any local data processing is legitimate interest (functionality of the App).

### 8.4 Under PIPEDA (Canada)

- No personal information is collected, used, or disclosed.
- Consent is obtained via Android's runtime permission system for device access (audio files, network).

### 8.5 Under APPI (Japan) and PIPA (South Korea)

- No personal information is acquired, held, or provided to third parties.

---

## 9. Children's Privacy

The App does not knowingly collect any personal information from children under the age of 13 (or the applicable age of consent in your jurisdiction). Since we do not collect any personal data from any user regardless of age, we are compliant with:

- **COPPA** (Children's Online Privacy Protection Act, USA)
- **GDPR Article 8** (Conditions applicable to child's consent)
- **Age Appropriate Design Code** (UK)

---

## 10. Data Security

Although we do not collect or transmit personal data, we implement the following security measures for local data:

- App data is stored in Android's sandboxed app-specific storage
- Release builds use ProGuard/R8 code obfuscation
- Network communications use HTTPS where available
- No sensitive data is stored in plaintext logs

---

## 11. International Data Transfers

**No international data transfers occur.** All user data remains exclusively on the user's device. The podcast search feature communicates with Apple's servers (located in the USA), but no personal data is included in those requests.

---

## 12. Changes to This Policy

We may update this Privacy Policy from time to time. Changes will be reflected by updating the "Last updated" date at the top of this document. Continued use of the App after changes constitutes acceptance of the revised policy.

For significant changes, an update notice will be included in the App's changelog on the Google Play Store.

---

## 13. Contact Us

If you have any questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us:

**Email:** andreas.delgaldo@googlemail.com

For GDPR-related inquiries, you also have the right to lodge a complaint with your local Data Protection Authority (DPA). In Germany, this is the relevant state commissioner for data protection (Landesdatenschutzbeauftragter).

---

## 14. Summary

| Question | Answer |
|----------|--------|
| Do you collect personal data? | **No** |
| Do you sell data? | **No** |
| Do you share data with third parties? | **No** |
| Do you use analytics? | **No** |
| Do you show ads? | **No** |
| Do you track users? | **No** |
| Where is data stored? | **Only on your device** |
| How do I delete my data? | **Uninstall the app** |

---

*This privacy policy is provided in good faith and is accurate as of the date stated above. Vibe Launcher is an independent project and is not affiliated with Apple, Google, or any other company mentioned in this document.*
