# ゴールデンコーパスと評価検証記録

`corpus/` および `src/corpus/` は、実装変更やプロンプト変更によって重大変更の見逃しやコンテキスト不足の誤判定が発生しないことを検証するための評価基盤です。

## 1. 合成ゴールデンコーパス構成 (`corpus/`)

コーパス内の全レコードは評価用に設計された 100% 合成データ（`synthetic: true`）であり、実在する Microsoft テナントの通知コピーではありません。

- **変更フィクスチャ (`corpus/changes/synth-mc-001..050.json`)**: 50 件。重大変更、管理者対応期限、廃止・非推奨、セキュリティ・プライバシー・コンプライアンス、不明シグナル（`unknown-signal`）、曖昧な適用範囲などを網羅。
- **テナントプロファイル (`corpus/tenant-profiles/synth-tenant-001..010.json`)**: 従業員規模・導入ワークロード・OS 環境・変更ポリシーが異なる 10 組織（計 `50 × 10 = 500` ペア）。
- **ゴールデンケース (`corpus/cases/synth-case-001..065.json`)**: 65 件の期待判定ラベル（5 状態すべてと必須 32 カバレッジタグを網羅）。

### コーパス検証・スモーク実行コマンド

```sh
pnpm corpus:validate   # 65 ケース・500 ペア整合性、最低リスク下限、および profiles/ と policies/ のスキーマ検証
pnpm analyze           # 外部 API 非使用で全 500 ペアを実行し状態分布とアクション数を 1 行 JSON 出力
pnpm phase1:report     # 500 ペア実行結果と 65 ゴールデンラベルを突合した Phase 1 ゲート判定レポート出力
```

## 2. 評価ハーネス指標 (`evaluateGoldenImpactStates`)

`src/corpus/evaluation-harness.ts` は期待状態と観測状態をケース ID 単位で照合し、以下の指標を算出します（分母が 0 の比率は数値を捏造せず `null` とする）。

- **`highImpactFalseNegatives`（重大変更の見逃し件数）**: `highImpact: true` のケースが `ACTION_REQUIRED` でも `REVIEW_REQUIRED` でもない状態に落ちた件数。必須ゲート条件は **`0` 件**。
- **`recall` / `precision` / `noiseRate`**: `ACTION_REQUIRED` と `REVIEW_REQUIRED` を陽性クラスとした二値分類の再現率・適合率・ノイズ率。必須ゲート条件は **`recall === 1`**。
- **`insufficientContextAccuracy`**: 期待値が `INSUFFICIENT_CONTEXT` のケースが正しく `INSUFFICIENT_CONTEXT` と判定された割合。必須ゲート条件は **`1`（全件一致）**。
- **`exactMatchAccuracy`**: 5 状態の完全一致率。

決定論的パス単体（`pnpm phase1:report`）でも、上記 3 つの測定必須条件（`highImpactFalseNegatives = 0`, `recall = 1`, `insufficientContextAccuracy = 1`）はすべて `PASS` しています。

## 3. OpenAI Structured Outputs 検証記録（2026-08-29 実施）

通常の CLI・CI は外部 LLM を一切呼び出しませんが、`StructuredImpactClassifier` 境界の実モデル適合性を確認するため、2026-08-29 に合成ゴールデンコーパス全 65 ケースに対する手動検証（`pnpm provider:validate`）を実施しました。

- **検証モデル / プロンプト**: OpenAI Responses API `gpt-5.4-mini-2026-03-17`（`store: false`, `reasoning.effort: "low"`, リクエスト固有 `evidenceId` enum 制約つき JSON Schema Structured Outputs）、プロンプト版 `m365-change-radar-impact-classifier-v3`。

| 測定項目                                                             |                                                        観測結果 |
| -------------------------------------------------------------------- | --------------------------------------------------------------: |
| 対象ゴールデンケース数                                               |                                                           65 件 |
| OpenAI API 呼び出し件数 / `DETERMINISTIC_FINAL`（呼び出し 0 回）件数 |                                                   54 件 / 11 件 |
| 重大変更の見逃し (`highImpactFalseNegatives`)                        |                                                        **0 件** |
| 要対応・要確認の再現率 (`recall`)                                    |                                                         **1.0** |
| `INSUFFICIENT_CONTEXT` 正答率 (`insufficientContextAccuracy`)        |                                                 **5 / 5 (1.0)** |
| 5 状態の完全一致数 (`exactMatchCount`)                               |                                               51 / 65 (`0.785`) |
| 適合率 (`precision`) / ノイズ率 (`noiseRate`)                        |                                               `0.867` / `0.133` |
| 自動証跡 ID・対象コンポーネント整合チェック                          |                                            **54 / 54 全件合格** |
| 人手による自由記述理由の根拠外主張（ハルシネーション）監査           |                               **0 / 54 件（根拠外主張率 `0`）** |
| 総トークン数（入力 371,100 / 出力 13,554）                           |                                                384,654 トークン |
| 推定 API コスト（GPT-5.4 Mini 標準単価スナップショット）             |                                                **USD 0.339318** |
| API レイテンシ（最小 / p50 / 平均 / p95 / 最大）                     | `1,793 ms` / `2,967 ms` / `3,450 ms` / `5,752 ms` / `16,818 ms` |

### 検証から得られた知見と境界保護

- **Fail-closed 動作の実証**: 初回試行時、モデルが証跡 ID ではなくプロファイルパス文字列 `services.viva` を `supportingEvidenceIds` に返したケースが 1 件発生し、ドメイン検証器が即座に拒否してレポート出力前に停止した。これを受け、リクエストごとの有効 `evidenceId` 列挙型を JSON Schema 側にも付与（prompt v3）し、全 54 件の自動検証通過を確認した。
- **不一致 14 件の内訳**: 期待値 `REVIEW_REQUIRED` が `ACTION_REQUIRED` へ引き上がった安全側エスカレーションが 8 件、期待値 `INFORMATIONAL` が `REVIEW_REQUIRED` となった安全側偽陽性が 6 件であり、危険側の見逃しは 0 件であった。
