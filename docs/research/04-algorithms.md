# 調査：核のアルゴリズムの理論的な基盤と、既知の手法

- 調査日：2026-11-02（ハッカソン開始前）
- 方法：調査担当（AIエージェント）が、論文と OR-Tools の公式資料を中心にWebで集め、開発チームが整理した。
- 注意：調査の途中でWeb検索の回数の上限に達したため、後半は既知のURLやDOIを直接読んで確かめた。確かめられなかったものは§5に書く。

## 1. 要点

- **問題の分類**：本作の問題は、時間窓と暦（営業時間・勤務）があり、担当者を選べる資源制約スケジューリング（RCPSP/max＋暦）である。そこに、店を選んで回る経路の問題（OP・TPP型）が一部加わる。
- **先例がある**：
  - 世帯員の活動と移動を同時に決める定式化は、交通工学の Recker 1995（再計画は Gan & Recker 2008）。
  - 個人の予定の制約プログラミング化は、SelfPlanner（一人の活動だけ）。
- **五つの仕組みは、どれも理論が確立している**：
  - 解けない時の説明：MUS/MCS、QuickXplain、FastDiag
  - 再計画：最小変更（minimal perturbation）
  - 複数の案：多様な解
  - 理由：対照的な説明（問いを制約にして解き直す）
  - 余裕：STNの柔軟性、POS
  - 公平：EF1と、繰り返しの配分
- **LLMとソルバーの組み合わせにも先例がある**（MeetMate 2024、Hao ら 2024）。
- **新しさは個々の算法ではない**。次の二つに置くのが妥当である。
  - 出典と確度を持つ条件が、配置・理由・確認・検証まで一貫して辿れる設計
  - 家庭の段取りの定式化
- 「残りチャンス」と同じ指標は見つからなかった（網羅はしていない）。

## 2. 仕組みごとの知見

### 2.1 制約モデルと求解

**既知の問題との対応**

- RCPSP：最小・最大の時間差と、資源の制約を扱う[5]。休止の暦つきの拡張もある[6]。
- OP：得点のある訪問先を、長さの上限の中で選ぶ[7]。
- TPP：店の選択・購入の計画・経路を、同時に決める[8]。
- HAPP：PDPTWの変種として、活動の選択と相乗りを含めて扱い、遺伝的アルゴリズムで解いた[3]。
- SelfPlanner：制約最適化問題として、squeaky wheel 法と前方検査で解く。会議など共同の活動は範囲外[1]。
- PTIME：書誌だけを確かめた[2]。

**CP-SATでの作り方**

- 作業×担当者ごとに任意の区間（存在のリテラル）を作り、その中から一つを選ぶ。
- 人ごとに NoOverlap を置き、勤務は固定の区間にする。子どもの同席が要る作業は、子の時間軸にも同じ区間を入れる。
- 営業時間は、非連続の定義域で表せる[9]。
- 任意の区間どうしの先後は、存在のリテラルで条件を付ける。
- 移動時間の公式の作り方は、回路制約。休みをまたぐ作業は、場合分けのリテラルで表す[10]。
- 目的は一つしか持てない[9]。締切 → 変更量 → 好み・公平の順に、段階に分けて解く。

**落とし穴**

- 15分×6週＝4032刻みを0/1の時間添字にすると、変数が百万単位になる。
- 初版では移動を往復として所要時間に含め、まとめ買いの経路は後で改善する。

### 2.2 解けない時：説明と取捨の案

**基盤**

- MUSの全列挙[11]。MUSとMCSを列挙する MARCO[12]。
- QuickXplain：制約の優先度に沿って、好ましい説明と緩和を出す[13]。
- FastDiag：最小の診断を、矛盾の検出なしで一つ出す[14]。
- 全ての最小矛盾ではなく、代表の小さな組を示す方法[15]。
- 利用者が、実行可能な状態を取り戻す過程を支える枠組み[16]。

**CP-SATでの作り方**

- 制約の群ごとに有効化のリテラルを付け、assumptions にする。解けない時、十分な前提の部分集合が返る。
- この部分集合は、最小である保証がない。縮めるのは、単スレッドで目的がない時だけで、それ以外は全ての前提を返す[9]。
- そこで、説明用の求解を別に組む。目的なし・num_workers=1 で解き、QuickXplain の要領で削って最小にする。
- 取捨の案の作り方：
  1. 時間休・祖父母・郵送・相談を、費用つきの緩和にする。
  2. 費用が最小になる組を解く。
  3. その組を禁じて解き直す。
  4. 2〜3を3回繰り返す（MCSの列挙）。費用が正なら、最適な組は、部分集合として最小になる。

**落とし穴**

- 群の単位は「出典の一項目」「一人の一日の勤務」にする。細か過ぎると読めず、粗過ぎると直し方が出ない。
- 推定の条件は、家族が確認するまで柔らかい制約にする。

### 2.3 最小変更の再計画

**基盤**

- 既存の活動の開始・終了の総移動量を最小にする（LPとCPの併用）[17]。
- 変更を形式化した MPP[18]。
- 安定性の指標：計画と実際の開始時刻の差の、重み付き和[19]。
- 世帯の再計画（書誌のみ確認）[4]。

**CP-SATでの作り方**

- 旧解をヒントとして渡す。部分的でも、条件に反していてもよい。repair_hint もある[20]。
- ただし、ヒントが使われる保証はない[9]。「動いた」リテラルと移動量を、目的に入れる。
- 通知済みの予定は重くして、動きにくくする。

### 2.4 多様な案

- **基盤**：
  - 最も多様なk個の解と、その計算量[21]。
  - 質と多様さを同時に扱い、過剰制約の問題にも使える[22]。
- **CP-SATでの作り方**：
  - 全解の列挙は目的がない時だけで、並列では同じ解が重複する[20]。
  - 最良の案を解いたら、「緩和の組が前の案と違う」という制約を足して、解き直す。

### 2.5 計算に基づく理由

**基盤**

- XAIPの問い「なぜそうしたか」「なぜ別のことをしなかったか」[23]。
- 利用者の問いは対照的なことが多い。問いを制約にした制限問題を解いて比べる[24]。
- 議論の枠組みで、スケジュールを説明する[25]。
- EXPRES：満たされない好みの理由をMILPで選び、読める形にする。社内の試験で、人が書いた説明より好まれた[26]。

**作り方**

- 「なぜもっと早くないか」には、「開始＜s」を足して解き直す。
  - 解けなければ、§2.2の方法で、効いた群とその出典を示す。
  - 解ければ、公平・好み・移動の各項がどれだけ悪くなるかを示す。
- LLMは、求解で確かめた理由を言い換えることだけを担う。

### 2.6 残りチャンス（不確実さと余裕）

**基盤**

- 所要時間の不確実さは STNU で扱う。動的可制御性の判定は、扱いやすい[27]。
- pSTN：失敗の確率に上限を置く[28]。
- STNの柔軟性は区間スケジュールで測り、多項式時間で最大化できる。事象の相関を無視する従来の指標は、過大評価になる[29]。
- POS：資源の衝突を先後に置き換え、実行可能な予定の集合を持つ[30]。
- 通知の先例は Jogger。物忘れの確率・関連・割り込みの費用から、決定理論で通知を決める[31]。

**数え方の案**

- 締切までの「人×日×窓」を、三通りで数える。
  - 楽観：他の作業を無視する。
  - 保守：今の解の、他の作業を固定する。
  - 厳密：窓ごとに解き直す。
- 通知は保守の値で判断する。
- 作業ごとの数は、同じ空き時間を重ねて数えているので、合計しない。
- 営業時間で定義域が非連続になるため、STNの多項式時間の結果は、そのままでは使えない。

### 2.7 公平な分担

- **基盤**：
  - 品が人によって財にも家事にもなる場合のEF1は、二重ラウンドロビンで多項式時間に作れる。二人なら離散版の Adjusted Winner で、EF1かつパレート効率の配分が多項式時間で作れる[32]。
  - 繰り返しの配分では、二人・偶数回なら、全体で羨望なし、かつパレート効率の列が存在する[33]。
- **作り方**：各人が感じる負担の重みを作業ごとに持ち、累積を繰り越して、|A−B| を目的に入れる。
- **落とし穴**：
  - 分の合計をそろえることと、各人の評価で羨望がないことは、別物である。
  - 時間や担当の制約の下でも上の保証が残るかは、未確認。

## 3. 本作への示唆

**採る手法**

- 区間のモデルと、段階に分けた目的
- 説明用の別の求解
- MCSの列挙による3案
- 距離を目的に入れた再計画
- 保守の数え方による残りチャンス
- 累積の公平の項

**避けること**

- 時間添字の0/1変数
- 推定の条件を、硬い制約にすること
- ヒントだけで安定させようとすること
- 作業ごとの機会の数を、合計すること
- LLMによる後付けの理由

**検証器**

- CP-SATの証明の出力は、純粋なSATに限られる[20]。したがって、「解けない」ことを証明として出せない。
- 検証器は、解の違反を検査する。それに加えて、小さなMUSを区間の計算で別に確かめる。

**検証できる仮説**

- H1：作業150件・6週・3人でも、実行可能な解が数秒で出る（文献の根拠はなく、実測が要る）。
- H2：説明の核は5群以下になり、数秒で出る。
- H3：3案は互いに違い、それぞれ部分集合として最小の緩和になる。
- H4：作り直しより、動く予定と各人への差分が減り、締切違反は増えない。
- H5：保守の機会の数は、「締切までの日数」より取りこぼしをよく予測し、通知の回数を減らす。
- H6：公平の項は、締切や好みを大きく損なわずに、偏りを縮める。

## 4. 新しさへの影響

**標準的な部分**

- 上の各算法と、公平分割の理論。
- 個人・世帯の予定の最適化[1][3][4]。
- LLMで条件を作り、ソルバーで解く流れ[34][35]。Hao らは、矛盾の核から修正案まで出している。

**新しいと言える候補**（先行の製品と論文の網羅は、調査03と合わせて判断する）

- (a) 学校の配布物から作った条件が、出典・確度とともに、理由・確認・検証まで辿れること。
- (b) 時間休・祖父母・郵送・相談を、費用つきの「やり方の許可」として扱う、MCSの選択肢。
- (c) 人と営業時間を考えた、保守の機会の数による通知。
- (d) 予見・見届けの負担を含む、時間をまたぐ二人の公平。
- (e) 説明のMUSを、独立した検証器で確かめること。

要素は既知で、新しさは領域と組み合わせにある。

## 5. 未確認・追加で調べるべきこと

- **本文を確認できなかったもの**：
  - Benadè ら 2018、Spliddit の分担の方式、Daminger 2019（認知的な家事）
  - Hägerstrand 1970 の制約の分類（書誌のみ確認）
  - Dechter ら 1991（STNの原典）
  - Autominder、CCPMのバッファ管理、Neutens らの複数人の時空間の機会
- **調べていないもの**：
  - 家族向けのAI予定や、学校の配布物を読み取る商用製品（調査03で扱った）
  - 「残りチャンス」と同じ指標の先例
  - 制約の下での公平分割
  - MaxSATでMCSを求める専門文献
  - CP-SATの、実際の規模での速さ

## 出典

1. Refanidis & Yorke-Smith (2010) A constraint-based approach to scheduling an individual's activities. ACM TIST 1(2). https://doi.org/10.1145/1869397.1869401
2. Berry ら (2011) PTIME: Personalized assistance for calendaring. ACM TIST 2(4). https://ir.webis.de/anthology/2011.tist_journal-ir0anthology0volumeA2A4.9/
3. Recker (1995) The household activity pattern problem. Transp. Res. B 29(1):61–77. https://ideas.repec.org/a/eee/transb/v29y1995i1p61-77.html
4. Gan & Recker (2008) A mathematical programming formulation of the household activity rescheduling problem. Transp. Res. B 42(6). https://doi.org/10.1016/j.trb.2007.11.004
5. Bartusch ら (1988) Scheduling project networks with resource constraints and time windows. Ann. Oper. Res. 16. https://doi.org/10.1007/BF02283745
6. Kreter ら (2016) RCPSP with general temporal constraints and calendars. EJOR 251(2). https://doi.org/10.1016/j.ejor.2015.11.021
7. Vansteenwegen ら (2011) The orienteering problem: A survey. EJOR 209(1). https://ideas.repec.org/a/eee/ejores/v209y2011i1p1-10.html
8. Manerba ら (2017) The Traveling Purchaser Problem and its variants. EJOR 259(1). https://doi.org/10.1016/j.ejor.2016.12.017
9. OR-Tools cp_model.proto. https://github.com/google/or-tools/blob/stable/ortools/sat/cp_model.proto
10. OR-Tools CP-SAT docs（scheduling.md・model.md）. https://github.com/google/or-tools/tree/stable/ortools/sat/docs
11. Liffiton & Sakallah (2008) Algorithms for computing minimal unsatisfiable subsets of constraints. JAR 40. https://doi.org/10.1007/s10817-007-9084-z
12. Liffiton ら (2016) Fast, flexible MUS enumeration. Constraints 21(2). https://doi.org/10.1007/s10601-015-9183-0
13. Junker (2004) QUICKXPLAIN. AAAI-04. https://mlanthology.org/aaai/2004/junker2004aaai-quickxplain
14. Felfernig ら (2012) An efficient diagnosis algorithm for inconsistent constraint sets. AI EDAM 26(1). https://arxiv.org/abs/2102.09005
15. O'Sullivan ら (2007) Representative explanations for over-constrained problems. AAAI-07. https://mlanthology.org/aaai/2007/oapossullivan2007aaai-representative
16. Senthooran ら (2021) Human-centred feasibility restoration. CP 2021. https://doi.org/10.4230/LIPIcs.CP.2021.49
17. El Sakkout & Wallace (2000) Probe backtrack search for minimal perturbation in dynamic scheduling. Constraints 5. https://doi.org/10.1023/A:1009856210543
18. Barták ら (2004) A new approach to modeling and solving minimal perturbation problems. Recent Advances in Constraints. https://is.muni.cz/publication/555152/en
19. Lambrechts ら (2008) Proactive and reactive strategies for RCPSP with uncertain resource availabilities. J. Sched. 11(2). https://iaorifors.com/paper/62159
20. OR-Tools sat_parameters.proto. https://github.com/google/or-tools/blob/stable/ortools/sat/sat_parameters.proto
21. Hebrard ら (2005) Finding diverse and similar solutions in constraint programming. AAAI-05. https://mlanthology.org/aaai/2005/hebrard2005aaai-finding
22. Petit & Trapp (2015) Finding diverse solutions of high quality to constraint optimization problems. IJCAI-15. https://ijcai.org/Abstract/15/043
23. Fox ら (2017) Explainable planning. https://arxiv.org/abs/1709.10256
24. Krarup ら (2021) Contrastive explanations of plans through model restrictions. JAIR 72. https://www.jair.org/index.php/jair/article/view/12813
25. Čyras ら (2019) Argumentation for explainable scheduling. AAAI-19. https://doi.org/10.1609/aaai.v33i01.33012752
26. Pozanco ら (2022) Explaining preference-driven schedules: the EXPRES framework. ICAPS. https://doi.org/10.1609/icaps.v32i1.19861
27. Morris ら (2001) Dynamic control of plans with temporal uncertainty. IJCAI-01. https://mlanthology.org/ijcai/2001/morris2001ijcai-dynamic
28. Fang ら (2014) Chance-constrained probabilistic simple temporal problems. AAAI-14. https://doi.org/10.1609/aaai.v28i1.9048
29. Wilson ら (2014) Flexibility and decoupling in Simple Temporal Networks. AIJ 214. https://doi.org/10.1016/j.artint.2014.05.003
30. Policella ら (2004) Generating robust schedules through temporal flexibility. ICAPS-04. https://icaps04.icaps-conference.org/icapspapers/ICAPS04PolicellaN.pdf
31. Kamar & Horvitz (2011) Jogger: Models for context-sensitive reminding. AAMAS. https://www.microsoft.com/en-us/research/publication/jogger-models-for-context-sensitive-reminding/
32. Aziz ら (2019) Fair allocation of indivisible goods and chores. IJCAI-19. https://www.ijcai.org/proceedings/2019/8
33. Igarashi ら (2024) Repeated fair allocation of indivisible items. AAAI-24. https://arxiv.org/abs/2304.01644
34. Lawless ら (2024) "I Want It That Way": LLMs and constraint programming. ACM TiiS. https://doi.org/10.1145/3685053
35. Hao ら (2024) LLMs can solve real-world planning rigorously with formal verification tools. https://arxiv.org/abs/2404.11891

**本文は未確認（URLのみ）**

- Benadè ら 2018（DOIと論文の対応も未確認） https://doi.org/10.1145/3219166.3219179
- Goldman & Procaccia 2014 https://www.sigecom.org/exchanges/volume_13/2/GOLDMAN.pdf
- Daminger 2019 https://doi.org/10.1177/0003122419859007
- Hägerstrand 1970 https://doi.org/10.1007/BF01936872
