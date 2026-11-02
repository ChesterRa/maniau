# 調査：先行事例（研究と製品）と、新しさの確認

- 調査日：2026-11-02（ハッカソン開始前）
- 方法：調査担当（AIエージェント）が、論文・公式サイト・App Storeの説明など一次資料を中心にWebで集め、開発チームが整理した。製品は約30、研究は約30件を確認した。
- 注意：
  - 調査の途中でWeb検索の回数の上限に達した。日本の新しいアプリと Google Play の横断的な確認はできていない（§6）。
  - 製品の判定は、公式資料に記載があるかどうかによる。実機では試していない。判定の言葉は§4の凡例による（2026-11-02、開始後に「はい／いいえ／不明」から改めた）。「記載なし」は、機能が存在しないことの証明ではない。

## 1. 要点

- **抽出は新しさにならない**。おたより・メール・画面から、予定・持ち物・提出物をAIで抜き出す製品は、日本にも米国にも多数ある。
  - 例：プリクリ、Papercal、おたよりー〔2021〕、TimeTree 予定スキャン〔2023〜〕、Fambot、Skylight、Alexa+
- **最も近い製品は Fambot（2026-09公開）**。
  - メールと WhatsApp から、to-do・書類・持ち物を拾い、1日1回のまとめを送る。担当は手で付け、衝突は指摘する。
  - 二人の空き時間への逆算配置、機会の残数、代償付きの案は、公式資料では確認できなかった。
- **最も近い研究は ParPal（arXiv 2026-01）**。
  - LLM が、子どもの家庭学習の作業を、家族の複数の養育者へ、空き時間と得意分野を考えて配分し、週の計画まで作る。
  - 配分は、LLM の多段のプロンプトで行う。失敗の型として「物理的・時間的に実行できない作業」を挙げている。これは、ソルバーと独立の検証器を置く根拠になる。
- **次の要素は既にあり、「初めて」とは言えない**。
  - LLMと制約ソルバーの組み合わせと、候補ごとの説明（MeetMate、2024）
  - 解けない時の修正案（Hao ら、2024）
  - 最小変更の再計画（El Sakkout & Wallace、2000）
  - 締切が危ない時の警告（Motion）
- **組み合わせは、確認した範囲で見当たらない**。次の三つを家庭向けの一つの製品にした例は、確認した中になかった。
  - 家庭の準備作業を、二人の空き時間と店・窓口の営業時間を考えて、締切から逆算して置く。
  - 実行の機会が減った時だけ知らせる。
  - 解けない時に、家庭で実際に取れる緩和を、代償付きで出す。
- **単独の予定アシスタントは消えている**。
  - x.ai は2021年に単独の道具を終了、Clockwise は2026-03に終了、Maple は2026-12に終了予定。
  - 抽出と予定の登録は、OS・大手の機能へ移りつつある。差別化は計画の中身に置くべきである。

## 2. 研究の先行事例

### 2.1 2000年代：家族の調整

- **Brush & Turner**（GROUP 2005／MSR-TR-2007-28）[1]
  - 621人の調査。約51%が、家庭の予定を主に職場のデジタルカレンダーで管理していた。
  - 要望は「一か所に集める」「いつでも見られる」「家庭の予定の調整を楽にする」。
- **Neustaedter, Brush & Greenberg**（ACM TOCHI 16(1), 2009）[2]
  - 44家族の調査。家族の関与の度合いで三つの型（monocentric／pericentric／polycentric）に分けた。
  - カレンダーは、注記や付け足しで広がることを示した。
  - 関連：LINC の参加型設計（CHI 2006）と家庭での試用（GI 2007）[3]、共有の家族カレンダー（Plaisant ら、TOCHI 2006）[4]。
- **Taylor & Swan**（CSCW 2004）[5]：家庭のリストは、人・活動・家事の絡みをまとめるのに強い一方、分けて分類するのは苦手である。
- **Davidoff ら**（CMU）：
  - UbiComp 2006：共働き家庭の日課から、スマートホーム制御の原則を示した[6]。
  - CHI 2010：6家族を6か月、毎晩面接した。日課どおりに進む出来事は約40%で、家族の会話は主に「いつもと違う時」の調整だった。日課の情報で、カレンダーとリマインダーを補うよう提案した[7]。
  - CHI 2011：携帯のGPSから送迎を検出し、次の送迎を誰がするかを予測し、子が残される可能性を推定した[8]。
  - 未解決の点：知らせる・予測するところまでで、作業を配置し直す仕組みはない。UbiComp 2010 の該当論文は確認できなかった。

### 2.2 2018〜2026年：mental load と家族向けAI

- **Daminger**（ASR 84(4), 2019）[9]：35組70人の面接。女性は予見と見届けを多く担い、決定への参加はほぼ同等だった。
- **Barigozzi ら**（arXiv 2025、経済学）[10]：女性が段取りの責任を多く負い、相手はその負担を過小評価していた。
- **Frampton, Gould & Cox**（CHI 2026）[11]：
  - 50人の調査。道具は家事・予定など見える活動に偏り、価値に関わる労働は最も見えにくく、任せにくい。
  - 家族の管理は協働なのに、道具の多くは一人用である。
- **Wang ら**（CHI 2026）[12]：宿題の世話の認知・感情の労働は見えにくい。自動化より、関係の維持を目指すAIを提案した。
- **Sun ら**（CHI 2026）[13]：個人を中心にした設計が、家族内の緊張を生むと指摘した。
- **Wen ら**（PACM HCI の CSCW 号、2025）[14]：家庭の安全（詐欺や事故）を主題に、家族が思い描く生成AIの三つの役割の一つとして「家庭の管理役」を示した。
- **FamLearn（2025）と ParPal（2026）**[15][16]：同じ研究群。
  - LLM が作業を分解・配分し、各人の貢献を見えるようにする。
  - 11家族に1週間使ってもらい、調整の分かりやすさと、労力の認識が改善した。
  - ParPal の失敗の型は、役割の不一致、不要な協働、実行できない作業。
  - 専門家の評価で最も低かったのは、実行のしやすさだった（3点満点で GPT-4o 2.43、Claude 2.50）。
- **家事分担アプリへの批判**（MIT Technology Review 2022、報道）[17]：割り振る役を一人に置く設計が多く、現状を固めている。

### 2.3 LLM＋制約・説明・再計画（新しさの判定に直結）

- **MeetMate**（Lawless ら、ACM TiiS 14(3), 2024）[18]：
  - LLM が好みを判定のコードに直し、優先度の重み付きで候補の時刻を採点する。
  - 各候補について、満たす好みと満たさない好みを一文で説明する。
- **Hao ら**（arXiv 2404.11891）[19]：
  - LLM が計画を充足可能性問題に直してソルバーで解き、TravelPlanner の試験用の1000件で93.9%（Claude 3 Opus）。
  - 解けない要求では「解けない核」を特定し、理由と修正案を出す。
- **LLM単独の限界**：
  - TravelPlanner：GPT-4 の成功率は0.6%[20]。
  - NATURAL PLAN：問題が複雑になるほど、性能が急に落ちた[21]。
  - LLM-Modulo：外部の検証器と組み合わせることを提唱した[22]。
  - 関連：自然言語から制約モデルを作る研究（Holy Grail 2.0）[23]、論理とLLMで時間割を説明する TRACE-CS[24]。
- **古典的な手法**：
  - 最小摂動の再計画（Constraints 2000）[25]
  - 過剰な制約の、好ましい緩和（QuickXplain、AAAI 2004）[26]
  - 交通行動研究の、世帯内で作業を配分する活動モデル（Kim ら 2006）[27]。予測のためのモデルで、支援の道具ではない。

## 3. AI予定アシスタントの系譜

**研究**

- LookOut（Horvitz, CHI 1999）：メールから予定の意図を推定する。自動化と直接操作を組み合わせる原則を示した[28]。
- CMRadar（2004）：要求の自然言語処理から交渉まで含む予定管理[29]。
- RADAR（AAAI 2008）：メール過多を減らす[30]。
- CALO の PTIME（TIST 2011）：会議の好みを、目立たずに学習する[31]。
- SelfPlanner（TIST 2010）：個人の活動を制約最適化で予定に入れる。他人と行う活動は「固定の予定」として扱い、複数人の作業は対象外だった[32]。
- Calendar.help（CHI 2017）：定型の部分は自動化し、それ以外は訓練した人が処理した[33]。

**製品**

- x.ai：取得先が、単独の道具を終了した（2021）[34]。
- Clara：人が介在する方式。TechCrunch は「人を介在させる費用は皆の負担を上げる」と書いた[35]。
- Reclaim：Dropbox が取得（2024）し、継続している[36]。
- Motion：締切・所要時間・優先度から自動で配置し、締切のリスクを警告し、変更時に再計算する[37]。
- Clockwise：2026-03-27に終了した（報道と競合の資料による）[38]。
- Gmail「Help me schedule」（2025-10）[39]、Copilot の予定機能（2026）[40]。

**広がらなかった理由**

- 一次資料で言えるのは三つ：統合のための終了（x.ai）、人材の取得（Clockwise）、人が介在する費用（Clara）。
- 「会議の日程調整は、予約リンクとプラットフォームに吸収された」は推測である。

**家族への応用**：Davidoff の研究だけだった。SelfPlanner 型の配置を二人の大人へ広げた例は、見つからなかった。

## 4. 製品の比較表

- 確認日はすべて2026-11-02。
- 判定の項目：
  - (a) 通知から、前倒しの準備を作業として作る
  - (b) 二人それぞれの空き時間に、締切から逆算して置く
  - (c) 実行できる機会の残りで知らせる
  - (d) 解けない時に、代償付きの案を出す
  - (e) 変更時に最小限に組み直し、各人に差分だけ届ける
  - (f) 見えない家事や、分担の偏りを見えるようにする

判定の言葉（凡例）：

- 記載：公式の資料に記載がある（実装の深さは確かめていない）
- 曖昧：関係しそうな記載はあるが、同じ機能かは判定できない
- 記載なし：公開の資料に記載が見つからない（無いことの証明ではない）
- 実機で確認：実機で試して確かめた（あり／なし）。今は該当なし

| 製品 | a | b | c | d | e | f | 根拠 |
|---|---|---|---|---|---|---|---|
| プリクリ／おたよりー／Papercal | 曖昧 | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 「日時、持ち物、提出物の締め切り…を自動で抜き出します」[41]。「自動で予定・持ち物が入力」（2021年の記事）[42]。前日・当日朝の通知、変更の通知[43]。前倒しの準備を作る記載はない |
| ポストック | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | AIは書類の要約だけ[44] |
| TimeTree | 記載 | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 予定スキャンは画像から予定を作る（2024年に最大10件・表に対応）。「これから」は「ユーザーがこれから何をすると良いか、どう時間を使えば良いかについて、AIが先回りして支援する機能」で、「引っ越し」「テーマパークに行く」等の予定から「必要な準備ややることをAIが提案します」（2026-09-01の公式発表。「段階的に提供を拡大」とあり、提供の時期は記載なし）。家族への割り当て・空き時間への配置・衝突・リマインドの記載はない[45] |
| LINE Agent i in Chat | 曖昧 | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 会話から各メンバーのタスクを整理し、予定を登録。2026-07発表、2026年内の予定[46] |
| 学校・園の連絡（tetoru、すぐーる、マチコミ、コドモン、ルクミー） | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 配信・欠席連絡・自動翻訳。マチコミは期日のプッシュ通知と「やることリスト」。ルクミーの保育AIは職員向け[48] |
| Yieto（家事分担） | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 記載 | 約130の家事を、夫・妻・共同で色分け（2018年の記事）[49] |
| Fambot | 記載 | 記載なし | 記載なし | 曖昧 | 曖昧 | 曖昧 | 学校のメールから「events, to-dos, forms, deadlines」を拾う。日次のまとめは「know, do, and decide」。担当は手で付ける。「Calls out conflicts and decisions」[50] |
| Ohai | 曖昧 | 曖昧 | 曖昧 | 曖昧 | 曖昧 | 曖昧 | 「generating tasks」。mental load の軽減を主題に掲げる[51] |
| Sense | 曖昧 | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 「Events, deadlines, and reminders extracted」。家族の誰かへ割り当て、各人の分の予定へリンクする[52] |
| Nori／Folk | 曖昧 | 曖昧 | 曖昧 | 曖昧 | 曖昧 | 曖昧 | チラシの写真を予定にする[53]。締切をリマインダーにし、予約を取る[54] |
| Cozi／Skylight／Hearth／Alexa+／iOS 26 | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし（Hearth は曖昧） | いずれも、メール・紙・写真・画面を予定にする機能。「emails → events」[55]、「paper schedules, and PDFs into Calendar events」[56]、承認制[57]、「Add all early dismissals to my calendar」[58]、カレンダーへの追加を提案（発表時は英語のみ）[47] |
| Motion（個人・仕事向け） | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 一人分の逆算配置はある。「alerts you of at-risk deadlines」「instantly recalculates」[37] |
| Fair Play | 記載なし | 記載なし | 記載なし | 記載なし | 記載なし | 記載 | 家事100枚のカード。各カードに構想・計画・実行の段階がある。アプリは確認できず[59] |
| Maple | — | — | — | — | — | — | Wander が取得し、2026-12-31に終了[60] |

Milo、OurHome、Yohana、プリゼロは、公式資料を取得できなかったため判定していない（Yohana の日本のページは404だった）。

判定の軸（a〜f）は、開始前の方針による。開始後の方針（`../plan/02-product.md`）の軸、すなわち案ごとの決め時、引き受けの状態の追跡、変更で要らなくなった準備の取り消し、答えで決め方が変わる問いだけを聞くこと、については、まだ確かめていない（§6）。

## 5. 新しさへの影響と、設計への示唆

### 「初めて」と言ってはいけない点

- おたより・メールからの抽出（プリクリ、Fambot など）。
- 家族向けの日次のまとめ、家族の誰かへの作業の割り当て（Fambot、Sense、LINE）。
- LLMと制約ソルバーの組み合わせ、計算に基づく説明（MeetMate）、解けない時の修正案（Hao ら、QuickXplain）。
- 最小変更の再計画（2000年〜）、締切のリスクの警告（Motion）。
- 空き時間を考えて、家族の複数の大人へ作業を配分するAI（ParPal。対象は家庭学習の作業で、LLM の多段のプロンプトによる）。
- mental load を掲げる家族向けAI、分担の可視化（Ohai、Yieto、Fair Play、FamLearn）。

### それでも言える新しさ（確認した範囲での、組み合わせと家庭への当てはめ）

1. 家庭の準備作業を、二人の空き時間・営業時間・先後関係を制約として逆算で配置し、独立の検証器で確かめる製品。
2. 「実行できる機会の残数」で知らせる通知の方針。ただし余裕（工程管理のフロート）という考え方自体は古典的である。
3. 家庭で実際に取れる緩和（時間休・祖父母・郵送・相談）を、代償付きで最大3案示すこと。
4. 最小変更で組み直し、各人へ差分だけ送る家族向けの実装。製品で見つかったのは、変更の通知までだった。
5. 日本の学校・園の文書から、書かれていない準備まで推定し、出典付きで家族が確かめること。確認した日本の製品は、抽出止まりだった。

### 設計への示唆

- **主張の書き方**：「世界初」とは書かない。「確認した範囲で、〜を一つにした家庭向けの例は見当たらない」と書き、先行事例を併記する。
- **技術の中身を見せる比較**：同じ入力で、LLMのみと、LLM＋CP-SAT＋検証器を比べる。実行できる率、再計画で動いた予定の数、通知の回数を示すと、ParPal・TravelPlanner の失敗と対になる。
- **推定の誤りへの備え**：書かれていない準備の推定は、ParPal と同じく「不要」や「実行できない」誤りを生みうる。出典と推定を区別して表示し、家族の確認を通し、取り消しを容易にする。
- **確認の負担の偏り**：
  - システムの推定を確認・決定する役が一人に偏ると、それが新しい見えない労働になる（Daminger、MIT TR）。
  - 誰が何回確認・決定したかも、可視化の対象に入れる。
  - 道具は一人用が多い（Frampton）。二人とも受け手で、二人とも決定者にする。
- **価値の中心は再計画**：日課どおりに進む出来事は約40%（Davidoff）。変更時の再計画と差分の通知を、価値の中心として評価する。
- **「相手に相談」という案は研究と合う**：自動化より関係の維持を目指す、という提案がある（Wang 2026）。
- **入口は他社に寄せる**：抽出と予定の登録は、LINE・OS が取り込みつつある。入口は連携に任せ、差別化は計画の核に置く。
- **プライバシー**：家族のAIは子どもの情報を扱う（Partnership on AI 2025）[61]。家族の中に閉じた保存と、出典付きの表示は、信頼の面でも効く。

## 6. 未確認・追加で調べるべきこと

- 日本の2025〜2026年の新しい家族向けAIの網羅（App Store・Google Play の横断）。プリゼロ、Yohana、Milo、OurHome の現状。
- LINE Agent i in Chat の提供開始と、実際の機能。TimeTree「これから」の提供の時期と、実際の機能（一次資料の発表は確かめた）。
- 開始後の方針の軸（決め時、引き受けの追跡、変更による取り消し、答えで変わる問い）での、Fambot・Ohai・Sense・TimeTree・LINE Agent i・Motion・Reclaim の確認。
- Fambot・Ohai・Nori・Folk を実機で試し、担当の自動決定と、衝突時の提案があるかを確かめる。
- 学校と家庭の連絡アプリの研究（教育学・CSCW）と、日本の学会の研究。
- 機会に基づくリマインダーの研究（位置に基づくもの等）、Reclaim の締切リスクの表示との比較。
- Davidoff の UbiComp 2010 の論文。Fair Play で各作業の担当をどう決めるか（一次資料）。
- 特許の調査（未実施）。

## 出典

**研究**

1. Brush & Turner, GROUP 2005, doi:10.1145/1099203.1099263／MSR-TR-2007-28 https://www.microsoft.com/en-us/research/?p=153075
2. Neustaedter, Brush & Greenberg, TOCHI 2009, doi:10.1145/1502800.1502806
3. Neustaedter & Brush, CHI 2006, doi:10.1145/1124772.1124796／GI 2007, doi:10.1145/1268517.1268551
4. Plaisant ら, TOCHI 2006, doi:10.1145/1183456.1183458
5. Taylor & Swan, CSCW 2004, doi:10.1145/1031607.1031697
6. Davidoff ら, UbiComp 2006, doi:10.1007/11853565_2
7. Davidoff ら, CHI 2010, doi:10.1145/1753326.1753699
8. Davidoff ら, CHI 2011, doi:10.1145/1978942.1979119
9. Daminger, ASR 2019, doi:10.1177/0003122419859007
10. Barigozzi ら, arXiv:2505.11426
11. Frampton ら, CHI 2026, doi:10.1145/3772318.3791167
12. Wang ら, CHI 2026, arXiv:2602.10501
13. Sun ら, CHI 2026, doi:10.1145/3772318.3790865
14. Wen ら, CSCW 2025, arXiv:2508.11030
15. FamLearn, arXiv:2510.20123
16. ParPal, arXiv:2601.20737
17. MIT Technology Review 2022 https://www.technologyreview.com/2022/05/10/1051954/chore-apps/
18. Lawless ら, TiiS 2024, arXiv:2312.06908
19. Hao ら, arXiv:2404.11891
20. TravelPlanner, ICML 2024, arXiv:2402.01622
21. NATURAL PLAN, arXiv:2406.04520
22. LLM-Modulo, ICML 2024, arXiv:2402.01817
23. Holy Grail 2.0, arXiv:2308.01589
24. TRACE-CS, arXiv:2409.03671
25. El Sakkout & Wallace, Constraints 5(4), 2000, doi:10.1023/A:1009856210543
26. Junker, QuickXplain, AAAI 2004 https://cdn.aaai.org/AAAI/2004/AAAI04-027.pdf
27. Kim ら, IATBR 2006 https://its.uci.edu/research_products/conference-paper-a-household-activity-scheduling-model-incorporating-a-task-allocation-process-with-week-based-learning-mechanisms/

**AI予定アシスタントの系譜**

28. Horvitz, CHI 1999 https://www.erichorvitz.com/chi99horvitz.pdf
29. CMRadar https://ri.cmu.edu/publications/cmradar-a-personal-assistant-agent-for-calendar-management
30. RADAR, AAAI 2008 https://mlanthology.org/aaai/2008/freed2008aaai-radar
31. PTIME, TIST 2011, doi:10.1145/1989734.1989744
32. SelfPlanner, TIST 2010, doi:10.1145/1869397.1869401
33. Calendar.help, CHI 2017, doi:10.1145/3025453.3025780
34. x.ai の告知 https://webcf.waybackmachine.org/web/20210728155358/https://x.ai
35. https://techcrunch.com/2017/07/19/claraseriesa/
36. https://techcrunch.com/2024/08/22/dropbox-acquires-index-ventures-backed-ai-scheduling-tool-reclaim-ai/
37. https://www.usemotion.com/calendar
38. https://www.thestack.technology/clockwises-team-joins-salesforce-sunsetting-platform-as-they-go/／https://help.reclaim.ai/en/articles/14071543
39. https://blog.google/products/workspace/help-me-schedule-gmail-gemini/
40. https://mc.merill.net/message/RM542185／https://mc.merill.net/message/MC1296874

**製品（確認日 2026-11-02）**

41. https://apps.apple.com/jp/app/id6743779195
42. https://weekly.ascii.jp/elem/000/004/049/4049464/
43. https://apps.apple.com/jp/app/papercal/id6757946147
44. https://apps.apple.com/jp/app/id6443837941
45. https://www.watch.impress.co.jp/docs/news/1605367.html／https://it.impress.co.jp/articles/-/25184／https://www.advertimes.com/?p=556456／https://timetreeapp.com/intl/ja/newsroom/2026-09-01/mvw-redefine
46. https://www.watch.impress.co.jp/docs/news/2121879.html
47. https://www.apple.com/newsroom/2025/06/apple-elevates-the-iphone-experience-with-ios-26/
48. https://tetoru.jp/／https://apps.apple.com/jp/app/id1513854843／https://machicomi.jp/／https://www.codmon.com/／https://lookmee.jp/
49. https://media.moneyforward.com/articles/1132
50. https://apps.apple.com/us/app/id6746368694／https://techcrunch.com/2026/09/01/fambot-introduces-an-ai-chief-of-staff-for-families/
51. https://www.ohai.ai/
52. https://apps.apple.com/us/app/id6739470108
53. https://heynori.com/appfeatures/email-to-calendar
54. https://www.folk.com/for/parents.md
55. https://www.cozi.com/
56. https://myskylight.com/calendar/
57. https://hearthdisplay.com/products/hearth-display
58. https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence
59. https://www.fairplaypolicy.org/the-cards
60. https://growmaple.com/

**その他**

61. https://partnershiponai.org/can-ai-apps-help-carry-the-mental-load-for-moms/
