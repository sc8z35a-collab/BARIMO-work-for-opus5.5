# BARIMO 1.0 — まだ誰も知らない、美しい場所へ

世界の「全然有名じゃない、でも実はとてもきれいな」秘境12か所を、**実測標高データ × 高解像度衛星画像の3D地形**で旅する、横画面・全画面専用のスマホWebアプリです。

## 収録地域（12）
| ID | 地域 | 国 |
|---|---|---|
| tusheti | トゥシェティ | ジョージア |
| kolsuu | ケルスー湖 | キルギス |
| haftkul | ハフト・クル（七つの湖） | タジキスタン |
| semonkong | セモンコン／マレツニャネの滝 | レソト |
| dzukou | ズコウ渓谷 | インド |
| puluong | プールオン | ベトナム |
| itbayat | イトバヤット島 | フィリピン |
| ouvea | ウベア島 | ニューカレドニア |
| pomez | カンポ・デ・ピエドラ・ポメス | アルゼンチン |
| flores | フローレス島 | ポルトガル（アゾレス） |
| trnovacko | トルノヴァチュコ湖 | モンテネグロ／BiH |
| rugova | ルゴヴァ渓谷 | コソボ |

## 機能
- **3D地球儀**：衛星テクスチャ・大気・雲。ピン／カードで地域を選択
- **3D地形**：1024² DEM（全頂点メッシュ）× 4096² 衛星画像、4Kソフトシャドウ、空・大気遠近、ラグーン／海の水面シェーダ、雲、朝・昼・夕の時間帯、空撮カメラ、見どころラベル
- **ガイドパネル**：概要／ここがすごい／ベストシーズン／実測気候グラフ
- **多角評価**：景観美・秘境度・犯罪リスク・自然の危険・アクセス難度・体力難度・設備・費用の8軸レーダー＋安全度／行きやすさスコア
- **写真**：Wikimedia Commons から CC ライセンス写真を各12枚（明るさ・彩度スコアで自動選別、暗い写真は除外）
- 地域の歴史解説は意図的に省略しています

## 6エージェント・ビルドパイプライン
```
npm run pipeline            # 全12地域をビルド（エージェントごとに自動コミット）
node pipeline/orchestrator.mjs --region=tusheti --no-commit
```
| # | エージェント | 役割 |
|---|---|---|
| 1 | research | OSM Nominatim で見どころ座標を検証、Wikipedia で裏取り、LLM が使えれば評価の監査（6並列） |
| 2 | terrain | AWS Terrarium DEM タイルを 1024² 16bit 高さマップに合成 |
| 3 | imagery | Esri World Imagery を 4096² に合成・色補正（＋地球儀テクスチャ `globe.mjs`） |
| 4 | photos | Commons のテキスト検索＋位置検索 → ライセンス・横長・明るさで選別 → webp 化＋クレジット |
| 5 | climate | Open-Meteo ERA5 アーカイブ（2021〜24）から月別気候 |
| 6 | assembler | QA チェック、スコア算出、`public/data/regions.json` 出力（10地域未満ならビルド失敗） |

### v2 オーケストレーター（依存DAG・6レーン）
```
lane1 research → places | lane2 terrain | lane3 imagery → photos | lane4 climate
lane5 review（LLMスウォーム：6エージェント並列） | lane6 assembler/QA
node pipeline/orchestrator.mjs [--region=id] [--only=a,b] [--skip=a] [--no-commit] [--no-push] [--offline]
```
- 各エージェントは依存が揃った瞬間に起動し、終了ごとに自動コミット（環境リセットでも成果が消えない）
- `pipeline/out/run-report.json` に実行結果、`swarm-report.json` にAIレビュー結果
- review スウォームの6役割：fact-checker / safety-analyst / copy-editor / geo-verifier / season-advisor / qa-critic。LLM応答は厳密に検証（評価は元の値±1以内のみ採用など）し、LLMが使えない場合は決定論的なレビュアーに自動で切り替わる

（旧説明）ステージ1ではエージェント1〜5が並列に動き、画像処理の重い2つ（imagery→photos）はメモリ節約のため同じレーンで順番に処理します。その後ステージ2で assembler が実行されます。

### LLM について
`pipeline/lib/llm.mjs` は `~/.genspark_llm.yaml` / `OPENAI_*` 環境変数を使います。起動時に疎通を確認し（probe）、使える場合は research エージェントが6並列でLLM監査を行います。使えない場合（例：無料プランでプロキシが止められている場合）は、LLMなしの決定論的モードに自動で切り替わります。

## 開発
```
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview
python3 tools/shot.py http://localhost:4173/ tusheti   # 横画面スマホでのヘッドレスQA（?qa=1 軽量モード）
```

## クレジット
3D地形: AWS Terrain Tiles (Mapzen) / 衛星画像: Esri World Imagery / 気候: Open-Meteo (ERA5) / 写真: Wikimedia Commons（各撮影者・CCライセンス）/ 地名: © OpenStreetMap contributors
