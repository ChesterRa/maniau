# 調査：LLMの計画・日程調整の能力と、LLM＋ソルバーの研究

- 調査日：2026-11-02（ハッカソン開始前）
- 方法：調査担当（AIエージェント）がWebで一次資料（論文・公式の評価）を中心に集め、開発チームが整理した。
- 注意：
  - 2026年の査読前の論文を含む。数値は、モデル名・時期・設定と合わせて原典で確かめてから使うこと。
  - 調査の途中でWeb検索の回数の上限に達したため、後半は既知のarXiv番号を直接読んだ。

## 1. 要点

- **小さな日程の問題は、推論モデルなら素のチャットでもかなり解ける**。空き枠を探す、数件の締切を守る程度なら、o1-mini が NATURAL PLAN のカレンダー調整で94%（2024年）。平常の週（S1）では、本作と比較相手の差は小さく出る見込み。
- **制約や対象が増えると、推論モデルでも成績が急に落ちる**。
  - ZebraLogic の最大の問題で、o1 42.5%、R1 28.5%。
  - 自分で見直させてもほとんど直らない。正しさが保証された外部の検証器を使うと上がる。
- **解けない問題を「解けない」と言う力は弱い**。
  - o1-preview は、解けない問題の27%しか指摘できなかった。
  - 逆に、解ける問題の11.5%を「解けない」と誤って判定した領域もある。
- **決まった手順で形式化するLLM＋ソルバーは強い**。TravelPlanner で90〜98%（素の o1-preview は10%）。
- **その場でコードを書く方式（B2に当たる）は改善が速い**。
  - 2024年のモデルで31〜62%。
  - 2025年末の gpt-5.1 では、CP-SATで書かせると約69〜71%、試行を重ねて自己検証させると88%。
  - 残る誤りの多くは、実行はできるが誤った（または解のない）モデルで、黙って間違える。
- **同じ弱点は本作にもある**。利用者の文から制約への翻訳が最大の詰まりどころである（ChinaTravel）。ソルバーの保証は、抽出したモデルに対してしか成り立たない。
- **道具を持つエージェントは、1回の成功率よりも、繰り返しと長期の運用で崩れる**。
  - gpt-4o は1回なら61%成功するが、8回連続の成功は25%未満。
  - 時刻に合わせて動く課題では、GPT-5(high) が0.0%。
  - ただし2025〜26年の上位モデルでは大きく改善している。
- **見込み**：
  - 差として残りやすい：S3（解けない週）、S4（変更）、S5（連続運用）、結果の再現性。これらは仕組みの差である。
  - 差が縮む：S1、日付の計算と抽出、B2の定式化の精度。

## 2. 知見

### 2.1 計画・日程の基準での成績

- **NATURAL PLAN**（2024年、5-shot）[1]：
  - カレンダー調整は、GPT-4 41.2%、GPT-4o 43.7%、Gemini 1.5 Pro 48.9%。
  - 旅行計画は、10都市になると全モデルが5%未満。
  - 自己修正をさせると、全モデルで成績が下がった。
- **o1の評価**（2024年）[2]：
  - カレンダー調整は o1-mini 94%（o1-preview は未試験）。
  - TravelPlanner の検証用180件では、o1-preview 10%。Blocksworld の20〜40手の問題では23.6%。
  - 外部の検証器と反復させると、TravelPlanner は10%から65%に上がった。
- **LLM-Modulo**（2024年、10回反復）[3]：
  - カレンダー調整は、Claude 3.5 Sonnet が72.9%から88.8%に、GPT-4o が56.1%から83.3%に上がった。
  - 会議計画の10人の組では、Sonnet の正解が100件中11件から32件に増えた。
- **Mind Evolution**（2025年）[4]：
  - o1-preview を1回だけ使った場合、TravelPlanner 11.7%、会議計画 44.2%。
  - 評価関数を使った探索（Gemini 1.5 Flash）では、95.6%と85.0%。
  - カレンダー調整は「列挙で解ける」として評価から外されている。
- **TravelPlanner**：
  - GPT-4 は、道具を使う設定で0.6%[5]。
  - DeepSeek-R1 は、計画だけを任せる設定（試験用1000件）で40%。原論文ではなく第三者による評価[6]。
- **最新世代**[7]：GPT-5・Claude Opus 4.5・Gemini 3 Pro に旅程を各98件作らせた。
  - 必ず守るべき制約を全て満たしたものは、0件。
  - 1件あたりの違反の平均は、Opus 4.5 が1.08、Gemini 3 Pro が4.44、GPT-5 が9.03。最も多いのは移動時間の矛盾。
  - ただし2026年7月の査読前の論文で、著者は商用アプリの関係者。推論の設定は書かれていない。

### 2.2 制約の数・解けない問題・実行ごとのばらつき

- **ZebraLogic**（ICML 2025）[8]：
  - 小さな問題では97〜98%だが、最大の問題では o1 42.5%、R1 28.5%、GPT-4o 0.5%まで落ちる。
  - GPT-4o に自己検証させても31.7%から33.0%、32回の多数決でも38.0%。
- **解けない問題の判定**：
  - Blocksworld で o1-preview が解けないと指摘できたのは27%で、54%の問題には実行できない計画を出した。別の領域では指摘は16%にとどまり、解ける問題の11.5%を「解けない」と誤判定した[2]。
  - 推論向けの訓練で、答えるべきでない時に答えを控える力が、平均24%悪化した（20モデル）[9]。
  - 情報や道具が足りずに解けない依頼の判定は、GPT-4.1 35%、GPT-5.1 80%、R1 83.7%。思考型のモデルは、指示に従う型のモデルより低い傾向がある[10]。
- **自己点検**：GPT-4 に自分の答えを批判させると成績が崩れ、正しさが保証された外部の検証器を使うと上がった[11]。
- **ばらつき**：決定的になるよう設定した5モデルでも、実行ごとに正答率が最大15%変わった[12]。

### 2.3 日付・時間の計算と抽出

- **Test of Time**（2024年のモデル）[13]：期間の計算は13.5〜16%。誤答の2〜3割は1日のずれで、うるう年や月の数え違いもある。
- **PRIMETIME**（2026年改訂、各1回・100問）[14]：
  - 250日後の日付の計算は、Gemini 2.5 Pro が指示の書き方によって100%、GPT-5 が88〜97%、Claude Opus 4.0 が最大90%。
  - Gemini 3 Flash は、指示の書き方だけで24%から100%まで揺れた。
  - Claude Opus 4.5 は日時の判定問題で、思考なしなら54〜68%、段階的に考えさせると100%。
- **日本語**[15]：ニュースで省略された日付を正規化する課題（表現の範囲は与えた上で）では、GPT-4o 99.2%/98.2%、GPT-4o-mini 100%/97.0%。規則による手法は97.1%/94.3%。
- **好みを制約のコードに訳す**（会議の日程調整）[16]：
  - GPT-4 で、コンパイルが通るのが97.2%、適合率95.8%、再現率94.0%。
  - 調査担当の試算：各条件が独立に95%正しくても、20条件が全て正しい確率は約36%。

### 2.4 LLM＋ソルバー・形式化

- **基本の考え方**：
  - LLM+P は、計画の記述言語PDDLに訳してから古典的な計画器で解き、多くの問題で最適解を得た[17]。
  - LLM-Modulo は、「LLMは単独では計画も自己検証もできないが、外部の検証器と組めば役立つ」という立場[18]。旅行計画の事例研究では、GPT-4-Turbo で4.6倍、GPT-3.5-Turbo で0%から5%に上がった[19]。
- **Hao ら**（NAACL 2025）[20]：
  - SMTへの形式化で、TravelPlanner の試験用データは Claude 3 Opus 93.9%、GPT-4 90.2%（JSONの段を足すと97.0%）。
  - 指示を言い換えても86.7%。
  - 解けない依頼は、矛盾の核（unsat core）から理由を示して直し、模擬の利用者とのやり取り20回以内に、81.6%と91.7%を解決した。ソルバーを外すと25.2%。
- **LLMFP**（ICLR 2025）[21]：
  - 9課題の平均で、GPT-4o 83.7%、Claude 3.5 Sonnet 86.8%。
  - 同じモデルにその場でコードを書かせると、制約の多い課題で31.1%と44.2%（SMTで書かせると最大62.4%）。o1-preview に直接解かせると29.7%。
  - 自己評価の段を外すと、21.9点下がる。
- **DCP-Bench-Open**（2026年1月）[22]：
  - OR-Tools CP-SAT で書かせると、gpt-5.1 が約69〜71%、gpt-oss-120b が75.0%。
  - 資料を与え、10回試行させ、自己検証させると、gpt-5.1 は88.4%（CPMpy なら90.2%）まで上がる。
  - 残る誤りの主な型は、実行できるが誤った解を出すモデル、または解のないモデル。
- **基準そのものの誤り**：
  - 専門家11人の監査で、NL4Opt の正解の26.4%以上、IndustryOR の54.0%以上に誤りが見つかった。直したデータでは、ORLM が73.8%と42.9%[23][24]。
  - OptiMUS は、既存手法を20〜30%以上上回ると報告されている[25]。
- **検証の限界**：双対性と感度分析から作った、誤検出のない試験を束ねても、定式化の主要な誤りを見つけられたのは56.1%（条件付きで70.0%）[26]。
- **ChinaTravel**（ICLR 2026）[27]：
  - 素の ReAct は0〜5%。
  - 記号の処理と組み合わせた方式でも、DeepSeek-V3 は易しい問題で52.6%、人が書いた依頼の検証用で37.0%、試験用で23.3%。
  - 翻訳だけを正解に差し替えると、74.0%と45.4%に上がった。専用の記述言語（DSL）への翻訳が最大の詰まりどころで、構文の修復を繰り返すうちに制約が落ちていた。

### 2.5 道具を持つエージェント

- **τ-bench**[28]：gpt-4o の小売の課題は、1回で61.2%、8回とも成功するのは25%未満。失敗の19%は、複合的な依頼の一部だけを処理したもの。
- **τ²-bench**：
  - 利用者も操作する設定にすると、18〜25点下がった。Claude 3.7 Sonnet の通信の課題は49%[29]。
  - 公式の一覧では、1回の成功率の総合が Qwen3.5-397B 87.9%、Gemini 3.0 Pro 85.4%、Claude Opus 4.5 85.3%。繰り返しの一貫性（pass^k）は公開されていない[30]。
- **Flex-TravelPlanner**[31]：
  - 後から加わった優先度の低い好みのために、先にあった予算の制約を破る率は、GPT-4o 59%、Llama 3.1 70B 61.9%。
  - 条件を伝える順番でも、成績が変わる。
- **Vending-Bench**：
  - 全てのモデルに、途中で破綻した回があった（配達予定の読み違い、注文の忘れなど）。破綻は、文脈が一杯になる時点とは関係がなかった[32]。
  - 後継版では、上位モデルが1年間ぶれずに道具を使えたとしている（±の意味と実行回数は書かれていない）[33]。
- **Gaia2**[34]：
  - 時間の課題で、GPT-5(high) は0.0%（考えている時間も経過として数える既定の設定）。1手を1秒として数えると34.4%。
  - Claude 4 Sonnet は、8.1%から26.7%に上がった。

## 3. B0・B1・B2の予想

| 場面 | B0 素のチャット | B1 道具つき | B2 その場でソルバー |
|---|---|---|---|
| S1 平常の週 | 概ね解ける。移動時間・営業時間の取りこぼしが時々出る[2][7] | 計算の誤りが減り、概ね解ける | 解ける。列挙で足りる規模[4] |
| S2 行事が重なる週 | 制約が増えて急落し、予定の重なりや締切違反が出る。見直しでは直らない[3][8][11] | 道具は組み合わせの探索を助けないので、B0並みに加えて操作の誤り[28] | 定式化が正しければ解ける。ただし黙った誤りが1〜3割残る見込み[21][22] |
| S3 休むか頼まないと解けない週 | 解がなくても計画を出す、または誤って「解けない」と言う[2][9]。緩和が最小である保証はない | B0と同じ | ソルバーから「解なし」は返るが、定式化の誤りによる「解なし」と区別しにくい。最小の緩和は、その都度の作り込み次第[20][22] |
| S4 途中の変更 | 計画を作り直すため、変更が広がる恐れ（直接測った研究は未確認）。新しい条件のために重い条件を破る[31] | 一部だけ更新して、依存関係を取りこぼす[28] | 解き直すと解が大きく変わりうる（変更を抑える目的を自分で入れない限り） |
| S5 4週間の運用 | 状態も時刻での起動もないので、残りチャンス通知は仕組み上できない | 通知が来た時しか動かないので、時計がなければ時刻に応じた通知はできない[34]。長期の破綻の恐れ[32]（改善中[33]） | 状態を持たず、毎回モデルが変わる |

- **残る強み**（モデルの能力ではなく、仕組みの性質）：
  - 解けないことの証明と、代償付きの最小の緩和
  - 最小変更と、各人への差分
  - 持続する状態と、時刻での起動
  - 同じ入力から同じ結果を返すこと

  ただし強いB2は、矛盾の核や変更を抑える目的を、自分で入れることもできる。したがって本作の優位は「本作にしかできない」ことではなく、「検査済みの同じ方法を、毎回必ず使う」ことにある。
- **縮む範囲**：
  - S1の計画の質
  - 日付の計算と正規化
  - B2の定式化（2024年の31〜62%から、2025年末の88〜91%へ）
  - 道具の操作の信頼性
- **本作の弱点**：条件の抽出は、本作もLLMに頼る。抽出が誤れば、検証器もそのまま通してしまう[26][27]。出典の表示と、利用者が確認する操作が、保証の前提になる。

## 4. 比較実験の設計への提案

- **二つの入力で測る**：Aは元の材料から通しで、Bは正解として構造化した事実から測る。これで、抽出の誤りと計画の誤りを分けられる。
- **条件をそろえる**：
  - 全方式で、同じモデル・版・思考の設定を使う。
  - プロンプトの調整は、開発用の場面で同じ回数だけ許し、試験の前に凍結する。
  - B2には、CP-SATの資料、複数回の試行と自己検証、作業領域の保存を許し、強い比較相手にする[22]。
  - 本作が利用者に確認を求めるなら、B0〜B2にも、模擬の利用者に対して同じ回数の確認の質問を許す。
- **部品ごとの効果を分ける比較**：次の三つで、どの部品が差を生んでいるかが分かる。
  - B2＋本作の検証器
  - 計画の部分だけをLLMに替えた本作
  - B1＋毎日の時計による起動
- **回数と統計**：
  - 各場面を各方式で5回以上実行する。
  - 1回の成功率と、k回連続の成功率（pass^k）を出す。
  - 場面の種類ごとにまとめた標準誤差と、同じ問題での対の差を報告する。
  - 温度は下げない[12][28][35]。
- **採点**：
  - 本作とは別の人が、正解のモデルから自動の検査器を書く。
  - 次を測る。
    - 制約の違反数
    - 解けない問題の判定（誤って「解けない」と言った数も含む）
    - 網羅的な探索で求めた、正解の最小の緩和との一致
    - S4で動いた予定と、通知を受けた人の数
    - S5の通知の適合率・再現率・時期
  - 理由の説明は、正解の事実と照合する。
  - 有用さは、どの方式かを伏せた上で人が評価する。LLMによる採点は補助にとどめる。
- **規模を段階的に増やす**：作業や制約の数を5・10・20・40と増やして、落ち方を見る。解ける場面と解けない場面を、同じ数だけ入れる。
- **データの汚染を避ける**：
  - 公開の基準（TravelPlanner 等）は、試験に使わない。
  - モデルの学習時点より後に作った、非公開の日本の家庭の場面を使う。日付・祝日・振替休日・名前は乱数で変える。
  - 開発用と試験用のデータを分け、仮説と指標は事前に書いておく。
  - B0〜B2が勝った場面も報告し、費用と待ち時間も記録する。

## 5. 未確認・追加で調べるべきこと

- 最新モデル（Claude Opus 4.8/5、GPT-5.x、Gemini 3/4）の、TravelPlanner・NATURAL PLAN・ZebraLogic の一次資料は見つからなかった。Claude 3.7 は、τ²-bench 以外の結果を確認できていない。
- 最新モデルの τ²-bench の pass^k は、公式の一覧に出ていない。
- LLMに再計画させた時に動く予定の数を、直接測った研究は見つからなかった。
- 日本語のおたより・連絡アプリの画面・LINEからの日時の抽出（和暦、曜日、「来週の水曜」）の精度は、一次資料がない。自分たちで測る必要がある。
- [6]のR1 40%の再現、[7]の設定、[33]の±の意味は、確認できていない。
- 2026年の評価は、さらに探す余地がある。

## 出典

1. Zheng ら 2024. NATURAL PLAN: Benchmarking LLMs on Natural Language Planning. arXiv:2406.04520
2. Valmeekam ら 2024. Planning in Strawberry Fields: Evaluating and Improving the Planning and Scheduling Capabilities of LRM o1. arXiv:2410.02162
3. Gundawar ら 2024. Robust Planning with Compound LLM Architectures: An LLM-Modulo Approach. arXiv:2411.14484
4. Lee ら 2025. Evolving Deeper LLM Thinking. arXiv:2501.09891
5. Xie ら 2024. TravelPlanner: A Benchmark for Real-World Planning with Language Agents. ICML 2024. arXiv:2402.01622
6. Zhang ら 2025（v2 2026）. IMAGINE: Integrating Multi-Agent System into One Model for Complex Reasoning and Planning. arXiv:2510.14406
7. Dev ら 2026. From Feasibility to Desirability: Plan, Learn, Adapt (PLA) Framework for Personalized On-Device Itinerary Generation. arXiv:2607.15552
8. Lin ら 2025. ZebraLogic: On the Scaling Limits of LLMs for Logical Reasoning. ICML 2025. arXiv:2502.01100
9. Kirichenko ら 2025. AbstentionBench: Reasoning LLMs Fail on Unanswerable Questions. arXiv:2506.09038
10. Cheng ら 2025. Beyond Itinerary Planning: A Real-World Benchmark for Multi-Turn and Tool-Using Travel Tasks. ACL 2026. arXiv:2512.22673
11. Stechly ら 2024. On the Self-Verification Limitations of Large Language Models on Reasoning and Planning Tasks. arXiv:2402.08115
12. Atil ら 2024. Non-Determinism of "Deterministic" LLM Settings. arXiv:2408.04667
13. Fatemi ら 2024. Test of Time: A Benchmark for Evaluating LLMs on Temporal Reasoning. ICLR 2025. arXiv:2406.09170
14. Gaere, Wangenheim 2025（v2 2026）. PRIMETIME: Limits of LLMs in Temporal Primitives. arXiv:2504.16155
15. Yasuda, Ishihara 2026. Reproducing Omitted Temporal Expressions in Japanese News for Retrieval-Augmented Applications. EMNLP 2026 Industry. arXiv:2609.09569
16. Lawless ら 2024. "I Want It That Way": Enabling Interactive Decision Support Using Large Language Models and Constraint Programming. ACM TiiS 14(3). arXiv:2312.06908
17. Liu ら 2023. LLM+P: Empowering Large Language Models with Optimal Planning Proficiency. arXiv:2304.11477
18. Kambhampati ら 2024. LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks. ICML 2024. arXiv:2402.01817
19. Gundawar ら 2024. Robust Planning with LLM-Modulo Framework: Case Study in Travel Planning. arXiv:2405.20625
20. Hao ら 2025. Large Language Models Can Solve Real-World Planning Rigorously with Formal Verification Tools. NAACL 2025. DOI:10.18653/v1/2025.naacl-long.176（arXiv:2404.11891）
21. Hao, Zhang, Fan 2025. Planning Anything with Rigor: General-Purpose Zero-Shot Planning with LLM-based Formalized Programming. ICLR 2025. arXiv:2410.12112
22. Michailidis, Tsouros, Guns 2026. DCP-Bench-Open: Evaluating LLMs for Constraint Modelling of Discrete Combinatorial Problems（旧版CP-BenchはECAI 2025）. arXiv:2506.06052
23. Xiao ら 2025. A Survey of Optimization Modeling Meets LLMs: Progress and Future Directions. arXiv:2508.10047
24. Huang ら 2025. ORLM: A Customizable Framework in Training Large Models for Automated Optimization Modeling. Operations Research. arXiv:2405.17743
25. AhmadiTeshnizi ら 2024. OptiMUS: Scalable Optimization Modeling with (MI)LP Solvers and Large Language Models. ICML 2024. arXiv:2402.10172
26. Li, Hai 2026. Falsification-Based Verification of LLM-Generated Optimization Models: Sound Test Batteries and Their Detection Limits. arXiv:2607.16646
27. Shao ら 2024. ChinaTravel: An Open-Ended Travel Planning Benchmark with Compositional Constraint Validation for Language Agents. ICLR 2026. arXiv:2412.13682
28. Yao ら 2024. τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains. arXiv:2406.12045
29. Barres ら 2025. τ²-Bench: Evaluating Conversational Agents in a Dual-Control Environment. arXiv:2506.07982
30. Sierra. τ-bench Leaderboard（2026-11-02閲覧）. https://taubench.com/
31. Oh, Kim, Oh 2025. Flex-TravelPlanner: A Benchmark for Flexible Planning with Language Agents. ICLR 2025 Workshop. arXiv:2506.04649
32. Backlund, Petersson 2025. Vending-Bench: A Benchmark for Long-Term Coherence of Autonomous Agents. arXiv:2502.15840
33. Andon Labs. Vending-Bench 2（2026-11-02閲覧）. https://andonlabs.com/evals/vending-bench-2
34. Froger ら 2025. ARE: Scaling Up Agent Environments and Evaluations（Gaia2）. arXiv:2509.17158
35. Miller 2024. Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations. arXiv:2411.00640
