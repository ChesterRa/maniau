# 調査：予定の実行・記憶・計画・選択・通知に関する心理学と行動科学

- 調査日：2026-11-02（ハッカソン開始前）
- 方法：調査担当（AIエージェント）がWebで一次資料を中心に集め、開発チームが整理した。効果の大きさと、再現・撤回の状況を合わせて記す。
- 注意：
  - 一部の数値は二次情報による（本文に明記）。原典で確かめてから使うこと。
  - 調査の途中でWeb検索の回数の上限に達したため、後半はDOIと要旨を直接取得して確かめた。

## 1. 要点

- **実行意図（いつ・どこで・どうやって）**：メタ分析で効果は頑健だが、現場での効果は数ポイントにとどまる。機械が置いた枠でも同じ効果が出るかは、まだ誰も確かめていない。
- **撤回**：Ariely & Wertenbroch (2002) は2026-09-02に撤回された［17］。自分で決める締切の根拠には使わない。
- **計画すれば未完了の負担が消えるか**：Masicampo & Baumeister (2011)［6］の直接の追試は見つからなかった。
  - Zeigarnik効果（未完了をよく覚える）は、2025年のメタ分析で支持されなかった。
  - Ovsiankina効果（中断した作業を再開する）は、一貫して見られる［7］。
- **リマインダー**：効く。ただし回数の追加、遅い再送、損失の言い方では効果が上乗せされず、慣れと配信停止という費用もある。この点は「残りが少ない時だけ知らせる」方針と合う。
- **選択と信頼**：
  - 選択肢の過多は、平均すると効果がほぼゼロで、特定の条件でだけ起きる。
  - 既定は強く効く。利用者が少しでも直せると、アルゴリズムは使われる。
  - 説明は、誤った推奨の受け入れも増やす。
- **通知**：作業の切れ目まで遅らせること、日に数回にまとめることは支持されている。残りチャンス通知の考え方には、Horvitz らの先行研究がある［46,47］。
- **何を最適化するか**（推論）：主の目的は「予定がずれても期限内に終わる確率」、つまり予備の機会を残すこと。中断・家族への問い・変更の数は従の目的にする。

## 2. 知見

### (1) 実行意図

- **効果量**：
  - if-then の計画［1］の効果は、94検定で d=.65［2］。
  - 642検定では、認知・感情・行動の結果で d=.27〜.66。if-then の形式、高い動機、計画の反復で大きくなる。手がかりの分類に「時刻と場所」「作業の継ぎ目」がある［3］。
- **現場の実験**：社員3,272人。接種の日付と時刻を書かせると+4.2pt（対照33.1%）。日付だけでは+1.5ptで、有意差はなかった。接種日が1日しかない事業所で、効果が大きかった［4］。
- **展望記憶への効果**：若年 d=.445、高齢 d=.68（36比較）。その間の作業は、わずかに遅れる（d=.224）［5］。
- **頑健さ**：
  - 効果があること自体は頑健。ただし大きさは、公表の偏りで膨らむ。
  - ナッジ全体では、学術誌の平均が8.7ptなのに対し、行政の介入部門の大規模RCTの平均は1.4pt。差の約7割は公表の偏りによる［22］。
  - ナッジのメタ分析を公表の偏りで補正すると、効果の証拠が消えるという再分析もある［23］。
  - 研究の多くは本人が立てた計画を扱う。他者や機械が割り当てた枠と比べた研究は、見つからなかった。

### (2) 計画と未完了の目標

- **原研究**（5研究）［6］：
  - 未完了の目標は、侵入思考、目標に関する語の想起のしやすさ、無関係な課題の成績低下を起こした。
  - 具体的な計画を立てると、それが消えた。
- **頑健さ**：
  - 訂正・撤回の記録はない。直接の追試は見つからなかった（未確認）。
  - 同じ研究室の自我消耗の効果は、多施設の追試で d=.04 と d=.06 で、ほぼゼロだった［8］。
- **2025年のメタ分析**：Zeigarnik効果は支持されず、Ovsiankina効果は一般的に見られる［7］。

### (3) 展望記憶

- 予定表・アラーム・置いた物に意図を外に出すことは、非常に有効。ただし、外に出すかどうかを人は系統的な偏りで決める［9］。
- 行動できる場所に目立つ手がかりを結びつけると、実行が増える（6実験）［10］。74%対42%などの数値は、報道発表による二次情報。
- 事象基準でも、手がかりが今している作業の中心から外れると、年齢差が大きくなる［11］。
- 時間基準のほうが難しいとされるが、今回は一次資料の数値で確かめていない。

### (4) 計画錯誤

- **卒論の研究**［12］：予測33.9日に対し、実際は55.5日。予測内に終えたのは約30%で、最悪の場合の予測（48.6日）も超えた。数値は二次情報で、原典のPDFは読めなかった。
- **作業の分解**：分解すると見積りが伸び、錯誤が減る［13］。二次情報で、行き過ぎると逆に外すという指摘もある。
- **実行意図の効果**：着手を早め、中断を減らし、錯誤を減らした［14］（二次情報）。
- **較正**：実際の所要時間を示すと、予測が正確になる（3実験）［15］。類似の事例の実績で予測する方法（参照クラス予測）もある［16］。

### (5) 先延ばし・締切・リマインダー

- **締切**：自分で決める締切の代表的な研究［17］は撤回された。理由は未確認。
- **理論**［18］：
  - 現在バイアスは、記憶の限界の害を大きくする。
  - 本人はリマインダーの設定そのものを先延ばしにするので、予期しないリマインダーが役立つ。送る最適な時機がある。
- **貯蓄**［19］：
  - リマインダーで目標の達成が増え、目標と報酬を書くと特によく効いた。
  - 利得と損失の言い方で、有意差はなかった。遅い追加の通知は上乗せにならなかった。
- **歯科**［20］：1か月以内の予約が2倍を超えた。情報を足しても上乗せはなく、繰り返しても効果は強まりも弱まりもしなかった。
- **予防接種**［21］：
  - 47,306人に19通りの文を送り、平均で約5%増えた。最良は「あなた用に確保済み」と2回知らせる文だった。
  - 薬局の689,693人では、平均+2.0pt（6.8%）。
- **費用**：
  - 寄付のリマインダーは配信停止も増やす。これを無視すると、便益を10倍過大に評価する［24］。
  - 運動の提案の効果は、当初の+66%から時間とともに薄れた［25］。
- **残りの機会**：「残りの機会の数」を示す介入の実験は見つからなかった。

### (6) 選択と信頼

- **選択肢の過多**：
  - 有名なジャムの研究（24種類と6種類）［26］の後、50実験・N=5,036の統合では、平均効果はほぼゼロで、研究ごとのばらつきが大きかった［27］。
  - 99観測・N=7,202の統合では、次の4条件で過多が起きる：選択肢が複雑、課題が難しい、好みが定まっていない、労力を減らしたい［28］。
  - 最適な案の数を直接示した証拠はない。
- **既定**：d=.68（58研究、N=73,675）。推奨や「すでに自分のもの」という意味を持つと強い［29］。中間の案が選ばれやすい妥協効果にはメタ分析があるが、効果の大きさは未確認［30］。
- **アルゴリズムへの態度**：
  - 誤りを見ると、人より正確でもアルゴリズムを避ける［31］。
  - わずかでも修正できると使い続け、満足も成績も上がる［32］。
  - 一方で、一般の人がアルゴリズムの助言のほうに従う場面も多い［33］。
- **自動化への過信**：素人にも専門家にも起き、訓練や指示では防げない［34］。
- **説明**：
  - 説明は、推奨が正しいかどうかと関係なく、受け入れを増やした［35］。
  - 利用者に考えさせる仕掛けは過信を減らしたが、最も嫌われた［36］。
  - 確かめる手間を減らす説明なら、過信が減る［37］。
  - メタ分析では、説明を付けても、AIの予測だけを示す場合より成績は上がらなかった［38］。
  - 人の説明は「なぜPでなくQか」という対照の形をとる［39］。ただし、対照的な説明で依存が適切になることを直接示した実験は、確認できなかった。

### (7) 通知と中断

- **中断のコスト**：中断されると作業は速く終わるが、ストレスと時間の圧迫が増える［40］。
- **切れ目まで遅らせる**：
  - 不満と反応時間が減った［41］。
  - Yahoo! JAPAN の68万人超・3週間の実験では、反応時間が49.7%短くなった［42］。
- **まとめて届ける**［43］：
  - 1日3回（9時・15時・21時）にまとめると、ストレスが減った。
  - 1時間ごとのまとめは効果が小さく、通知なしでは不安が増えた。
  - 共著に Ariely がいるが、Crossref に訂正・撤回の記録はない。
- **通知を切った場合**：24時間切ると生産性は上がったが、つながりの感覚が減った（n=30）［44］。
- **受け入れやすさ**：通知への反応時間と、邪魔だという感じ方は、性格で大きく変わる［45］。
- **注意のモデル**：
  - Horvitz らは、知らせるのを遅らせる費用と、中断の費用を比べて、知らせるかを決めた［46］。
  - Jogger は、忘れている確率と利益から中断の費用を引いて、知らせる価値を計算した［47］。
- **回数**：1日1回が最適だという直接の証拠はない。

## 3. 本製品への示唆（検証できる仮説）

### 実行と通知

- **H1**：置いた枠を、「〇日、お迎えの帰りに駅前の店で名前シールを買う」のような if-then の文で示し、家族が一度確認する。これで期限内の実行率が、時刻のない一覧よりも、確認なしの自動配置よりも上がるか。効果は数pt規模と見込む［3,4］。
- **H2**：推奨の枠を「確保済み」の既定にし、一手で動かせるようにする。空き枠から選ばせるより、受け入れも実行も多くなるか［21,29］。
- **H3（残りチャンス）**：残りの機会がk以下の時だけ知らせる方式が、固定間隔の通知と同等以上の実行率を、少ない通知数で達成できるか［19,20,24,25］。
  - 指標は「実行1件あたりの通知数」と、通知の停止・削除率。
- **H4**：「あと1回」のような損失の言い方は、中立の言い方を上回らないと予想する［19］。既定は中立にし、A/Bで決める。

### 取捨の選択肢と理由

- **H5**：疲れた夜の判断は、過多が起きる4条件に当たる［28］。
  - 案は3つまでにし、推奨1つを既定にする。
  - 並びは費用の順に固定し、中間の案に偏る［30］のを避ける。
  - 各案に「何を緩め、誰が何を負担するか」を一行で示す。
- **H6**：家族が枠を動かせると、誤りを見た後も使い続けてもらえるか［32］。
- **H7（理由）**：
  - 理由は「効いた制約1つと、出典の一句」に絞り、確かめる手間を減らす［37］。
  - 読み取りの確信が低い締切だけ、家族に確認を求める［36］。
  - わざと入れた日付の誤りを家族が見つける率で、過信の度合いを測る［34,35］。

### 較正・負担・着手・時機

- **H8（較正）**：所要時間と前倒し日数を家族の実績から更新し、平均ではなく上の分位で余裕を取る。これで期限の超過が減るか［12,15,16］。
- **H9**：計画を確定すると負担感が減るかは、効果として主張しない。元の研究に追試がないため［6］、尺度を使って前後で測る。
- **H10**：中断した作業は再開されやすい［7］。「今夜5分だけ名前付けを始める」のような小さな着手を提案すると、完了が早まるか。
- **H11**：まとめの通知は、家庭の切れ目（子どもの就寝後など）に送る。次のまとめまでに機会が尽きる時だけ、すぐに知らせる［41,42,46］。

### 制約モデルと分担

- **目的関数**（推論で、直接の実験はない）：
  - 主の目的：置いた枠が失敗しても締切までに残る「予備の機会」の最小値を、大きくすること。
  - 従の目的：中断・家族への問い・変更の数を、小さくすること。
- **最小変更の再計画**：心理学の直接の根拠は見つからなかった。
- **四段階の分担**：
  - Daminger の段階は、自動化の4段階（情報の取得・分析・決定・実行）［48］に対応づけられる。
  - 決定を家族に残しても、システムによる案の絞り込みが決定を左右し、過信も残る［34］。除いた案とその理由を見られるようにする。

## 4. 新しさへの影響

「初めて」と言えない点：

- 時刻と場所を決めて、実行を促すこと［2–4］
- 忘れている確率と中断の費用から、知らせるかを決めること［46,47］
- 作業の切れ目まで遅らせること、まとめて届けること［41–43］
- 制約の推論と好みの学習で、予定を組む助手［49］
- スケジュールの説明［50］と、「なぜAでなくBか」に答える計画の説明［51］

先例が見つからず、新しさとして残る点：

- (a) 二人の空き時間と、店や窓口の営業時間から「実行できる機会の残数」を数え、それを通知の引き金と最適化の目的の両方に使うこと。
- (b) 出典に結びついた作業モデル、独立した検証器、家族による決定を分けた構成。
- (c) 頭を使う家事の各段階を、自動化の段階として、人と機械に割り振ること。

注意：HCI、家族の予定の研究、商用の自動予定化アプリの確認は、この調査では不十分（別の調査 03 で扱う）。

## 5. 未確認・追加で調べるべきこと

- Masicampo & Baumeister (2011) の直接の追試があるか（OSF、PsyArXiv）。
- Ariely & Wertenbroch の撤回の理由と、同じ著者を含む Fitz ら (2019) の扱い。
- 二次情報に頼った数値の、原典での確認：Buehler 1994、Iyengar & Lepper 2000、Rogers & Milkman 2016、Kruger & Evans 2004、Koole & van't Spijker 2000。
- 要旨を取得できなかった研究：
  - Halkjelsvik & Jørgensen 2012：作業の長さで、見積りの偏りの向きが変わるか。
  - Zhu ら 2018「見かけの緊急さの効果」：残りチャンスの表現が、重要な作業を押しのける恐れ。
  - Tu & Soman 2014：締切の時間の区分と、着手の関係。
  - Lim ら 2009：「なぜ」と「なぜ〜でないか」の説明の比較。
- まとめの通知の時刻と回数の、直接の証拠。
- 頭を使う家事の負担を測る尺度（別の調査 01 で扱う）。

## 出典

1. Gollwitzer 1999. Implementation intentions: Strong effects of simple plans. Am Psychol. https://doi.org/10.1037/0003-066X.54.7.493
2. Gollwitzer & Sheeran 2006. Implementation intentions and goal achievement: A meta-analysis. Adv Exp Soc Psychol. https://doi.org/10.1016/S0065-2601(06)38002-1
3. Sheeran, Listrom & Gollwitzer 2025. The when and how of planning (642 tests). Eur Rev Soc Psychol. https://doi.org/10.1080/10463283.2024.2334563
4. Milkman et al. 2011. Using implementation intentions prompts to enhance influenza vaccination rates. PNAS. https://doi.org/10.1073/pnas.1103170108
5. Chen et al. 2015. The effect of implementation intention on prospective memory. Psychiatry Res. https://doi.org/10.1016/j.psychres.2015.01.011
6. Masicampo & Baumeister 2011. Consider it done! JPSP. https://doi.org/10.1037/a0024192
7. Ghibellini & Meier 2025. Interruption, recall and resumption: a meta-analysis of the Zeigarnik and Ovsiankina effects. HSSC. https://doi.org/10.1057/s41599-025-05000-w
8. Hagger et al. 2016. A multilab preregistered replication of the ego-depletion effect. PPS. https://doi.org/10.1177/1745691616652873 ／ Vohs et al. 2021. A multisite preregistered paradigmatic test of the ego-depletion effect. Psychol Sci. https://doi.org/10.1177/0956797621989733
9. Gilbert et al. 2023. Outsourcing memory to external tools: A review of 'intention offloading'. PBR. https://doi.org/10.3758/s13423-022-02139-4
10. Rogers & Milkman 2016. Reminders through association. Psychol Sci. https://doi.org/10.1177/0956797616643071
11. Kliegel, Jäger & Phillips 2008. Adult age differences in event-based prospective memory. Psychol Aging. https://doi.org/10.1037/0882-7974.23.1.203
12. Buehler, Griffin & Ross 1994. Exploring the "planning fallacy". JPSP. https://doi.org/10.1037/0022-3514.67.3.366
13. Kruger & Evans 2004. If you don't want to be late, enumerate. JESP. https://doi.org/10.1016/j.jesp.2003.11.001
14. Koole & van't Spijker 2000. Overcoming the planning fallacy through willpower. EJSP. <https://doi.org/10.1002/1099-0992%28200011%2F12%2930%3A6%3C873%3A%3AAID-EJSP22%3E3.0.CO%3B2-U>
15. Roy, Mitten & Christenfeld 2008. Correcting memory improves accuracy of predicted task duration. JEP:Applied. https://doi.org/10.1037/1076-898X.14.3.266
16. Flyvbjerg 2008. Curbing optimism bias and strategic misrepresentation in planning. Eur Plan Stud. https://doi.org/10.1080/09654310701747936
17. Ariely & Wertenbroch 2002. Procrastination, deadlines, and performance. Psychol Sci. <https://doi.org/10.1111/1467-9280.00441> （撤回通知：<https://doi.org/10.1177/09567976261488042>）
18. Ericson 2017. On the interaction of memory and procrastination. JEEA. https://doi.org/10.1093/jeea/jvw015
19. Karlan et al. 2016. Getting to the top of mind: How reminders increase saving. Manag Sci. https://doi.org/10.1287/mnsc.2015.2296
20. Altmann & Traxler 2014. Nudges at the dentist. Eur Econ Rev. https://doi.org/10.1016/j.euroecorev.2014.07.007
21. Milkman et al. 2021. A megastudy of text-based nudges… PNAS. https://doi.org/10.1073/pnas.2101165118 ／ Milkman et al. 2022. A 680,000-person megastudy of nudges… in pharmacies. PNAS. https://doi.org/10.1073/pnas.2115126119
22. DellaVigna & Linos 2022. RCTs to scale. Econometrica. https://doi.org/10.3982/ECTA18709
23. Maier et al. 2022. No evidence for nudging after adjusting for publication bias. PNAS. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9351501/
24. Damgaard & Gravert 2018. The hidden costs of nudging. J Public Econ. https://doi.org/10.1016/j.jpubeco.2017.11.005
25. Klasnja et al. 2019. Efficacy of contextually tailored suggestions for physical activity (HeartSteps). Ann Behav Med. https://doi.org/10.1093/abm/kay067
26. Iyengar & Lepper 2000. When choice is demotivating. JPSP. https://doi.org/10.1037/0022-3514.79.6.995
27. Scheibehenne, Greifeneder & Todd 2010. Can there ever be too many options? JCR. https://doi.org/10.1086/651235
28. Chernev, Böckenholt & Goodman 2015. Choice overload: A conceptual review and meta-analysis. JCP. https://doi.org/10.1016/j.jcps.2014.08.002
29. Jachimowicz et al. 2019. When and why defaults influence decisions. BPP. https://doi.org/10.1017/bpp.2018.43
30. Simonson 1989. Choice based on reasons. JCR. https://doi.org/10.1086/209205 ／ Neumann, Böckenholt & Sinha 2016. A meta-analysis of extremeness aversion. JCP. https://doi.org/10.1016/j.jcps.2015.05.005
31. Dietvorst, Simmons & Massey 2015. Algorithm aversion. JEP:General. https://doi.org/10.1037/xge0000033
32. Dietvorst, Simmons & Massey 2018. Overcoming algorithm aversion. Manag Sci. https://doi.org/10.1287/mnsc.2016.2643
33. Logg, Minson & Moore 2019. Algorithm appreciation. OBHDP. https://doi.org/10.1016/j.obhdp.2018.12.005
34. Parasuraman & Manzey 2010. Complacency and bias in human use of automation. Hum Factors. https://doi.org/10.1177/0018720810376055
35. Bansal et al. 2021. Does the whole exceed its parts? CHI. https://doi.org/10.1145/3411764.3445717
36. Buçinca, Malaya & Gajos 2021. To trust or to think. PACM HCI (CSCW). https://doi.org/10.1145/3449287
37. Vasconcelos et al. 2023. Explanations can reduce overreliance on AI systems during decision-making. CSCW. https://arxiv.org/abs/2212.06823
38. Schemmer et al. 2022. A meta-analysis of the utility of explainable AI in human-AI decision-making. AIES. https://doi.org/10.1145/3514094.3534128
39. Miller 2019. Explanation in artificial intelligence: Insights from the social sciences. Artif Intell. https://doi.org/10.1016/j.artint.2018.07.007
40. Mark, Gudith & Klocke 2008. The cost of interrupted work. CHI. https://www.ics.uci.edu/~gmark/chi08-mark.pdf
41. Iqbal & Bailey 2008. Effects of intelligent notification management on users and their tasks. CHI. https://doi.org/10.1145/1357054.1357070
42. Okoshi et al. 2017. Attention and engagement-awareness in the wild. IEEE PerCom. https://research.lycorp.co.jp/jp/papers/198
43. Fitz et al. 2019. Batching smartphone notifications can improve well-being. CHB. https://doi.org/10.1016/j.chb.2019.07.016
44. Pielot & Rello 2017. Productive, anxious, lonely: 24 hours without push notifications. MobileHCI. https://doi.org/10.1145/3098279.3098526
45. Mehrotra et al. 2016. My phone and me. CHI. https://doi.org/10.1145/2858036.2858566
46. Horvitz, Jacobs & Hovel 1999. Attention-sensitive alerting. UAI. https://arxiv.org/abs/1301.6707
47. Kamar & Horvitz 2011. Jogger: Models for context-sensitive reminding. AAMAS. https://www.erichorvitz.com/jogger_aamas.pdf
48. Parasuraman, Sheridan & Wickens 2000. A model for types and levels of human interaction with automation. IEEE SMC-A. https://doi.org/10.1109/3468.844354
49. Berry et al. 2011. PTIME: Personalized assistance for calendaring. ACM TIST. https://doi.org/10.1145/1989734.1989744
50. Čyras et al. 2019. Argumentation for explainable scheduling. AAAI. https://doi.org/10.1609/aaai.v33i01.33012752
51. Krarup et al. 2021. Contrastive explanations of plans through model restrictions. JAIR. https://doi.org/10.1613/jair.1.12813
