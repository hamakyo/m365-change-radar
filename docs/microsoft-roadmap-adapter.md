# Microsoft 365 公開ロードマップアダプタ仕様

`MicrosoftRoadmapAdapter`（`src/adapters/microsoft-roadmap/`）は、認証不要で取得できる Microsoft 365 公開ロードマップフィードを検証・正規化し、`{ changeEvent: ChangeEvent, sourceMessageVersion: string }` を出力します。

## 1. 対応エンドポイントと通信制御

1. **JSON API（`--live` 既定エンドポイント）**: `https://www.microsoft.com/releasecommunications/api/v1/m365`
   - `id`, `title`, HTML `description`, `status`, `publicDisclosureAvailabilityDate`, `publicPreviewDate`, `moreInfoLink`, UTC の `created` / `modified`, および `tagsContainer`（`products`, `cloudInstances`, `releasePhase`, `platforms`）を含む配列（または OData `{ value: [...] }`）をパースする。
2. **RSS 2.0 XML（スナップショット / 代替エンドポイント）**: `https://www.microsoft.com/microsoft-365/RoadmapFeatureRSS`
   - 外部 XML 依存ライブラリを使わず `<item>` 要素（`<guid>`, `<link>`, `<title>`, `<description>`, `<pubDate>`, `<a10:updated>`, `<category>`）を解析し、末尾の `GA date:` / `Preview date:` 表記を分離して JSON API と同一構造へ変換する。

`fetchMicrosoftRoadmapFeed` は Node.js 22 標準 `fetch` と `AbortController`（既定タイムアウト `20,000ms`）を使用し、ネットワーク一時障害・タイムアウト・HTTP `408` / `429` / `5xx` に対して指数バックオフ再試行（既定最大 2 回）を行います。HTTP `404` 等の恒久エラーやスキーマ不正は再試行せず即座に失敗します。

## 2. 製品・クラウド正規化マッピング表

`MICROSOFT_ROADMAP_PRODUCT_MAP` および `MICROSOFT_ROADMAP_SOVEREIGN_CLOUD_PRODUCT_MAP` は、ロードマップ上の生タグを [`policies/tenant-applicability-policy.json`](../policies/tenant-applicability-policy.json) のセレクター値へ正規化します。

| ロードマップ上の生タグ                                                                                                                                     | 正規化後の `ChangeEvent.products`    | 適用性ポリシールール ID              | 参照する `TenantProfile` フラグ                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| `Microsoft Teams`, `Teams`                                                                                                                                 | `Microsoft Teams`                    | `teams-applicable`                   | `services.teams`                                                               |
| `Exchange`, `Exchange Online`                                                                                                                              | `Exchange Online`                    | `exchange-outlook-applicable`        | `services.exchange_online`                                                     |
| `Outlook`                                                                                                                                                  | `Outlook`                            | `exchange-outlook-applicable`        | `services.exchange_online`                                                     |
| `SharePoint`, `SharePoint Online`                                                                                                                          | `SharePoint Online`                  | `sharepoint-onedrive-applicable`     | `services.sharepoint_online`                                                   |
| `OneDrive`, `OneDrive for Business`                                                                                                                        | `OneDrive`                           | `sharepoint-onedrive-applicable`     | `services.sharepoint_online`                                                   |
| `Microsoft Intune`                                                                                                                                         | `Microsoft Intune`                   | `intune-applicable`                  | `services.intune`                                                              |
| `Microsoft Entra`, `Microsoft Entra ID`, `Azure Active Directory`                                                                                          | `Microsoft Entra ID`                 | `entra-id-applicable`                | `services.entra_id`                                                            |
| `Microsoft Defender for Office 365`                                                                                                                        | `Microsoft Defender for Office 365`  | `defender-for-office-365-applicable` | `services.defender_for_office_365`                                             |
| `Microsoft 365 Defender`, `Microsoft Defender`, `Microsoft Defender for Endpoint`                                                                          | `Microsoft Defender`                 | `defender-suite-applicable`          | `services.defender_for_endpoint` または `services.defender_for_office_365`     |
| `Microsoft Purview`, `Microsoft Information Protection`                                                                                                    | `Microsoft Purview`                  | `purview-applicable`                 | `services.purview_compliance`                                                  |
| `Power Apps`, `Power Automate`, `Power Pages`, `Microsoft Dataverse`, `Microsoft Power Platform governance and administration`, `Microsoft Copilot Studio` | `Microsoft Power Platform`           | `power-platform-applicable`          | `services.power_platform`                                                      |
| `Microsoft Viva`                                                                                                                                           | `Microsoft Viva`                     | `viva-applicable`                    | `services.viva`                                                                |
| `Microsoft Copilot (Microsoft 365)`                                                                                                                        | `Microsoft 365 Copilot`              | `m365-copilot-applicable`            | `services.m365_copilot`                                                        |
| `Microsoft 365`, `Microsoft 365 admin center`, `Microsoft 365 Admin Center`, `Planner`, `Forms`, `Whiteboard`, `Microsoft To Do`, `Microsoft Clipchamp`    | `Microsoft 365`                      | `microsoft-365-core-applicable`      | `services.microsoft_365`                                                       |
| `Microsoft 365 app`, `Word`, `Excel`, `PowerPoint`, `OneNote`, `Access`, `Visio`, `Microsoft Project`                                                      | `Microsoft 365 Apps`                 | `microsoft-365-apps-applicable`      | `services.microsoft_365_apps`                                                  |
| `Microsoft Stream`                                                                                                                                         | `Microsoft Stream`                   | `stream-applicable`                  | `services.stream`                                                              |
| `Microsoft Edge`                                                                                                                                           | `Microsoft Edge`                     | `edge-applicable`                    | `services.microsoft_edge`                                                      |
| `Windows`                                                                                                                                                  | `Windows`                            | `windows-client-applicable`          | `environment.windows`                                                          |
| `Windows 365`                                                                                                                                              | `Windows 365`                        | `windows-365-applicable`             | `services.windows_365`                                                         |
| `Dynamics 365 *`（全 14 製品）                                                                                                                             | `Dynamics 365`                       | `dynamics-365-applicable`            | `services.dynamics_365`                                                        |
| 非 `Worldwide` 専用 `cloudInstances`（`GCC`, `GCC High`, `DoD`, `China (21Vianet)`）                                                                       | `Microsoft Cloud GCC` ほか 3 種      | `sovereign-cloud-*-applicable`       | `environment.cloud_gcc`, `cloud_gcc_high`, `cloud_dod`, `cloud_china_21vianet` |
| マッピング表にない新設タグ（例: `Work IQ`, `Universal Print`）                                                                                             | 生文字列をそのまま `products` に保持 | 該当ルールなし（`missingMappings`）  | 他の一致製品がなければ `INSUFFICIENT_CONTEXT`                                  |

変換前の生配列（`rawProducts`, `normalizedWorkloads`, `unmappedProducts`, `cloudInstances`, `releasePhases`, `platforms`, `rawTags`）はすべて `ChangeEvent.sourceMetadata` に保存されます。

## 3. 保守的シグナル抽出 (`extractRoadmapSignals`)

HTML タグ除去・エンティティ復号後の平文 `body`、`title`、製品タグを検査し、確認済み不在を含む完全な `ChangeSignals` を生成します。

- `severity`: 公開ロードマップには重大度フィールドが存在しないため常に `null`（確認済み不在）。
- `signals.actionRequiredBy`: 提供予定月（例: `February CY2027`）は管理者の必須作業期限日時ではないため、偽の ISO 日時を捏造せず常に `null` とする。
- `signals.isRetirementOrDeprecation`: 単語境界での `retire` / `retirement` / `deprecate` / `deprecation` / `end of support` 出現時のみ `true`（対応タグを付与）。
- `signals.isMajorChange`: `major change` / `breaking change` / `mandatory migration` / `default behavior change` 等の明示語句がある時のみ `true`。
- `signals.hasAdminImpact`: `no administrator action required` 等の否定表現を除外した上で、管理センター製品タグまたは管理者設定表現（`admin center`, `admins can/will`, `configured by admins`, `group policy`, `powershell` 等）がある場合に `true`。
- `signals.hasSecurityImpact`: 専用セキュリティ製品（`Microsoft Defender *`）または明示的な認証・脅威対策語句（`Conditional Access`, `MFA`, `Quarantine`, `Threat Explorer`, `Zero Trust` 等）がある場合に `true`。
- `signals.hasComplianceImpact` / `hasPrivacyImpact`: `Sensitivity label`, `DLP`, `eDiscovery`, `Retention policy/label`, `Communication compliance`, `Audit log` 等の統制御句、または `GDPR` / `personal data` / `privacy controls` がある場合に `true`。

## 4. 不変ソースバージョン (`sourceMessageVersion`)

`computeRoadmapSourceMessageVersion` は正規化後の正準 JSON（`source`, `externalId`, `publishedAt`, `updatedAt`, `title`, `body`, `status`, 提供予定時期, `moreInfoLink`, `cloudInstances`, `products`, `categories`）の SHA-256 先頭 16 文字を計算し、`roadmap-v1:<updatedAt>:<sha256-16hex>` を返します。Microsoft 側でタイトル・本文・提供時期・対象クラウドのいずれかが更新されると必ず新しい版識別子になります。
