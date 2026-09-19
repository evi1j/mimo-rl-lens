/* 指标与图表的逐项讲解库。
   每个词条回答五个问题：这是什么 / 这图怎么看 / 现在的数在说什么 / 什么情况要警惕 / 和谁有关。
   now 函数拿到实时数值后生成解读，所以讲的内容跟着数据走，不是背好的固定文案。
   注意：只讲机制，不用比喻代替解释。术语首次出现当场说明。 */
(function (global) {
  var G = { items: {}, modules: {}, order: [] };

  /* ---------- 工具：给 now 函数用 ---------- */
  function pct(v) { return (v * 100).toFixed(1) + "%"; }
  function num(v, d) { return v == null ? "--" : (+v).toFixed(d == null ? 2 : d); }
  function big(v) {
    if (v == null) return "--";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + " B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + " M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + " K";
    return (+v).toFixed(0);
  }
  function hours(v) {
    if (v == null) return "--";
    var h = Math.floor(v / 3600), m = Math.round((v % 3600) / 60);
    return h + " 小时 " + m + " 分";
  }
  function trend(c) {
    if (c.delta == null) return "持平";
    if (Math.abs(c.delta) < 1e-9) return "持平";
    return c.delta > 0 ? "上升" : "下降";
  }

  function def(o) {
    G.items[o.k] = o;
    G.order.push(o.k);
    return o;
  }

  /* ================================================================
     训练指标（对应「训练指标全景」里的 18 张卡片）
     ================================================================ */

  def({
    k: "dynsam/avg@n", zh: "平均通过率", unit: "pct",
    one: "主成绩。它涨了才说明模型真的变强。",
    what: "每道题让模型采样 n 次（当前是 16 次），统计答对次数占比，再对所有题取平均。" +
          "它是 RL 训练里唯一直接反映「模型会不会做」的指标：训练损失、奖励这些都会动，" +
          "但只有这个数涨了才算真的学到东西。",
    read: "横轴是训练步 step，纵轴是通过率。两条线分别是 pro 和 flash 两个独立训练任务。" +
          "单步会抖 1～2 个百分点属于正常——每步换一批新题，难度本来就不一样。" +
          "要看的是三五步连起来的斜率，不是某一步的涨跌。两条线的相对高低有意义，" +
          "绝对值不能直接和别的模型比（题库和采样次数不同）。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在 pro 是 " + pct(c.last) + "，flash 是 " + pct(c.flash) + "。";
      if (c.first != null) s += "相比第一步（" + pct(c.first) + "）累计变化 " +
        (c.last - c.first > 0 ? "+" : "") + ((c.last - c.first) * 100).toFixed(1) + " 个百分点。";
      if (c.delta != null && Math.abs(c.delta) > 0.005) {
        s += "最近一步" + trend(c) + " " + Math.abs(c.delta * 100).toFixed(2) + " 个百分点，" +
             (Math.abs(c.delta) < 0.02 ? "属于正常抖动。" : "幅度不小，可以继续观察下一步是否延续。");
      }
      if (c.max != null && c.last >= c.max - 1e-9) s += "目前处在历史最高点。";
      return s;
    },
    watch: "连续四五步往下掉、且零分率同时在涨，就要警惕了——可能是训练不稳、判分口径变了，" +
           "或者题库难度突然上台阶。单独一步下跌不必紧张。",
    link: ["dynsam/passrate/zero", "dynsam/passrate/one", "dynsam/num_measurable", "critic/rewards/mean"],
  });

  def({
    k: "critic/rewards/mean", zh: "平均奖励", unit: "num",
    one: "判分口径的整体松紧，不完全等同于答对率。",
    what: "本步参与训练的所有轨迹（一次完整作答算一条轨迹）的奖励均值。" +
          "奖励不一定只由「答对没」决定：还可能包含长度惩罚、格式分、工具调用次数等 shaping 项，" +
          "也就是人为加进去、用来引导行为的附加分。",
    read: "纵轴是平均奖励，横轴是 step。它和通过率应当大体同向，但幅度不必一致。" +
          "如果通过率在涨而奖励没涨，说明模型答对的题变多了，但每道题拿到的附加分在降" +
          "（比如回答变长被扣分）——这通常是正常的策略调整，不是问题。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "现在平均奖励 " + num(c.last) + "，最近一步" + trend(c) +
             "。把它和通过率对照着看：两者背离说明奖励里的附加项在起作用，不是模型变笨了。";
    },
    watch: "奖励持续涨但通过率不涨，是奖励黑客的典型信号——模型找到了判分规则的漏洞，" +
           "在不真正答对的情况下刷高分数。这也是为什么必须守住通过率这个独立标尺。",
    link: ["dynsam/avg@n", "actor/entropy_loss"],
  });

  def({
    k: "actor/entropy_loss", zh: "策略熵", unit: "num",
    one: "衡量输出还有多少不确定性。掉太快会丧失探索能力。",
    what: "策略在生成每个 token 时输出分布的平均熵。熵是信息论里度量不确定性的量：" +
          "分布越平均（多个候选差不多可能）熵越高，分布越尖锐（几乎只选一个）熵越低。" +
          "熵高代表输出多样、还在探索；持续下降代表策略在收敛、越来越确定。",
    read: "纵轴是熵值，横轴是 step。健康的曲线是缓慢下降——模型一边学一边收窄选择。" +
          "两条线对比可以看出哪个 run 收敛得更快。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在熵是 " + num(c.last) + "，最近一步" + trend(c) + "。";
      if (c.first != null && c.last < c.first * 0.5) {
        s += "相比第一步已经腰斩，收敛得比较快，需要留意别掉进熵坍缩。";
      } else if (c.first != null && Math.abs(c.last - c.first) / Math.abs(c.first) < 0.2) {
        s += "整体变化不大，说明探索空间还保持得比较充分。";
      }
      return s;
    },
    watch: "熵掉得太快甚至趋近 0，是熵坍缩：模型对任何题都只输出那一种解法，丧失探索能力，" +
           "后续很难再提升。工程上常用 entropy bonus（给高熵一点奖励）或 KL 惩罚来拖住它。",
    link: ["actor/pg_loss", "dynsam/passrate/one", "train_infer_diff/new_infer/kl"],
  });

  def({
    k: "actor/pg_loss", zh: "策略梯度损失", unit: "num",
    one: "不追求降到 0。看趋势，不看绝对值。",
    what: "PPO 的裁剪版策略梯度目标，也就是参数更新时真正优化的那个量。" +
          "它把「这个动作比同组平均好多少」（advantage）作为权重，去放大好动作的概率。" +
          "裁剪（clip）是为了限制单步更新幅度，防止一次更新把策略推得太远。",
    read: "纵轴是损失值，横轴是 step。它不像监督学习那样要一路降到 0：" +
          "符号和幅度取决于本批 advantage 的分布，甚至可以是负的。有意义的是它是否稳定——" +
          "剧烈上下跳说明批次间差异大。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "现在是 " + num(c.last, 4) + "，最近一步" + trend(c) +
             "。别把它当成「越低越好」的成绩单：它只是优化过程的中间量，要看通过率才知效果。";
    },
    watch: "持续大幅震荡、或突然出现极端值，说明批次里混进了异常样本，" +
           "可以对照梯度范数和零分率一起排查。",
    link: ["actor/grad_norm", "actor/entropy_loss", "dynsam/avg@n"],
  });

  def({
    k: "actor/grad_norm", zh: "梯度范数", unit: "num",
    one: "训练稳不稳的仪表盘。飙升通常是异常样本的信号。",
    what: "裁剪前的全局梯度范数，也就是把所有参数的梯度当成一个向量、量它的长度。" +
          "它反映这一步更新有多「猛」。PPO 会按 max_grad_norm 做裁剪兜底，" +
          "超过阈值就整体缩放到阈值，所以不会真的把参数带飞。",
    read: "纵轴是范数，横轴是 step。正常应该在某个区间内小幅波动。" +
          "孤立的一个尖峰通常是一次性噪声，连续几步抬升才值得关注。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在是 " + num(c.last, 3) + "，最近一步" + trend(c) + "。";
      if (c.max != null && c.last > c.max * 0.9 && c.max > 0) {
        s += "已经接近历史高位，留意下一步是否回落。";
      } else {
        s += "处在常规区间内。";
      }
      return s;
    },
    watch: "连续几步飙升，往往意味着一批异常样本或数值精度问题。" +
           "因为存在裁剪兜底，它更多是预警信号而不是故障本身。",
    link: ["actor/pg_loss", "train_infer_diff/new_infer/kl"],
  });

  def({
    k: "train_infer_diff/new_infer/kl", zh: "推理/训练 KL", unit: "num",
    one: "两个引擎算出来的概率差多少。异步 RL 必须盯的校准项。",
    what: "同一批序列在推理引擎（vLLM，负责生成）和训练框架下算出的 log-probs（对数概率）差异。" +
          "理想情况应该接近 0。两边是不同实现、不同数值精度，难免有差，但差太大就有问题。",
    read: "纵轴是 KL 散度（两个分布的差异度量），横轴是 step。越接近 0 越好，" +
          "出现台阶式跳变通常对应引擎版本或配置变更。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在是 " + num(c.last, 5) + "。";
      s += Math.abs(c.last) < 1e-3 ? "数值很小，说明两侧实现对齐得不错。"
                                   : "这个量级的偏差会让重要性采样比失真，需要留意。";
      return s;
    },
    watch: "偏大会让重要性采样比（用来校正旧权重采样的那个比值）失真，" +
           "等于在错误的梯度方向上更新。这是异步 RL 特有的坑：生成和训练拆开了才需要处理它。",
    link: ["partial/avg_staleness", "actor/grad_norm"],
  });

  def({
    k: "ctx_total_length/mean", zh: "平均上下文长度", unit: "int",
    one: "直接决定显存与耗时的成本指标。悄悄上涨就等于成本在涨。",
    what: "每条轨迹的上下文总长（题目 + 回答），单位 token。" +
          "attention 的计算代价是长度的平方级（序列越长，两两比较的次数增长更快），" +
          "所以这个数哪怕只涨一点，算力和显存开销都会明显上升。",
    read: "纵轴是 token 数，横轴是 step。它和生成阶段耗时、训练 token 量应当大体同步。" +
          "如果它涨而通过率没涨，说明模型在写更长的答案但没更有效。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在是 " + big(c.last) + " token。";
      if (c.first != null) {
        var r = (c.last - c.first) / c.first * 100;
        s += "相比第一步变化 " + (r > 0 ? "+" : "") + r.toFixed(1) + "%，" +
             (r > 10 ? "涨幅不小，意味着单步成本在上升。" : "基本稳定。");
      }
      return s;
    },
    watch: "持续大幅上涨会挤爆显存（KV cache 随长度线性增长）并拖慢生成，" +
           "工程上通常设长度上限并做截断。",
    link: ["timing_s/outer_gen", "perf/total_num_tokens", "dynsam/agg_turn/mean"],
  });

  def({
    k: "dynsam/agg_turn/mean", zh: "平均交互轮数", unit: "num",
    one: "agent 和环境来回多少次。轮数越多，生成越慢。",
    what: "每条轨迹里 agent 与环境的平均交互轮数——一次工具调用或一次环境反馈算一轮。" +
          "这类 agent 任务不是一问一答，而是「观察→行动→看结果→再行动」的多轮循环。",
    read: "纵轴是轮数，横轴是 step。它和上下文长度正相关：每多一轮就多一批 token。" +
          "轮数变多可能是模型学会了更充分地尝试，也可能只是变啰嗦了，要结合通过率判断。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "现在平均 " + num(c.last, 1) + " 轮，最近一步" + trend(c) +
             "。轮数涨而通过率也涨，是好事；轮数涨而通过率不动，多半是在空转。";
    },
    watch: "轮数暴涨通常伴随上下文长度和耗时一起涨，是成本失控的前兆。" +
           "超过环境设定的最大轮数，轨迹会被截断，拿不到有效奖励。",
    link: ["ctx_total_length/mean", "timing_s/outer_gen"],
  });

  def({
    k: "perf/total_num_tokens", zh: "本步训练 token 量", unit: "big",
    one: "账单的主要来源。与算力开销近似成正比。",
    what: "这一步实际参与训练的 token 总数。它约等于「题数 × 每道题采样次数 × 每条轨迹长度」，" +
          "所以是三个因素相乘的结果——任何一个变大，它都会变大。",
    read: "纵轴是 token 数（大数会缩写成 K/M/B），横轴是 step。" +
          "它和累计花费的斜率基本同步，可以当成「每步烧多少钱」的代理指标。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "本步 " + big(c.last) + " token，最近一步" + trend(c) +
             "。把它乘以步数，就是这台训练已经跑过的总 token 量级。";
    },
    watch: "单步 token 量突然跳升，先查上下文长度和采样次数有没有变，再查是不是题库换了一批更难的题。",
    link: ["ctx_total_length/mean", "dynsam/agg_turn/mean", "timing_s/step"],
  });

  def({
    k: "timing_s/step", zh: "单步总耗时", unit: "sec",
    one: "一步要几小时。所以看板几小时没动静是正常的。",
    what: "一个训练步的墙钟时间，等于生成耗时 + 训练耗时 + 判分与数据搬运。" +
          "RL 的一步不像监督学习那样只是一次前向加反向：它要先让模型生成上万个完整轨迹，" +
          "再拿这些轨迹做多次参数更新。",
    read: "纵轴是耗时（小时），横轴是 step。看单步耗时不如看它的构成——" +
          "下面两张耗时图会拆开生成和训练各自占多少。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "最近一步用了 " + hours(c.last) + "。按这个节奏，一天大约能跑 " +
             (24 / (c.last / 3600)).toFixed(1) + " 步。";
    },
    watch: "耗时持续变长，多半是上下文长度或交互轮数在涨；突然变长则要查是不是重启过、或者卡在等数据。",
    link: ["timing_s/outer_gen", "timing_s/trainer_ops", "ctx_total_length/mean"],
  });

  def({
    k: "timing_s/outer_gen", zh: "生成阶段耗时", unit: "sec",
    one: "单步里最大的一块：让模型大量做题的时间。",
    what: "rollout 阶段的耗时。RL 的训练数据由模型自己生成——先让它把题做一遍，才能判分、" +
          "才能算 advantage、才能更新参数。这个阶段要逐 token 解码上万条轨迹。",
    read: "纵轴是耗时，横轴是 step。把它和单步总耗时对比，就能知道生成占了几成。" +
          "生成通常是瓶颈，因为解码是逐个 token 串行的，没法像训练那样靠大 batch 摊薄。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "生成用了 " + hours(c.last) + "。这是异步流水线存在的理由：" +
             "生成是吞吐瓶颈，训练是另一套算力，拆开才能都不闲着。";
    },
    watch: "占比持续升高说明生成跟不上训练，队列会积压，进而拉大策略陈旧度。",
    link: ["timing_s/step", "timing_s/trainer_ops", "env/active", "partial/avg_staleness"],
  });

  def({
    k: "timing_s/trainer_ops", zh: "训练阶段耗时", unit: "sec",
    one: "参数更新阶段。通常比生成更容易被并行摊薄。",
    what: "真正做参数更新的阶段：拿收集到的轨迹算 advantage、跑前向反向、更新权重。" +
          "它面对的是已经生成好的数据，可以切成大批次并行处理。",
    read: "纵轴是耗时，横轴是 step。正常应该明显小于生成耗时。" +
          "两者比例失衡（比如训练占比突然升高）往往不是算力问题，而是数据搬运或算子效率问题。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "训练用了 " + hours(c.last) + "，最近一步" + trend(c) + "。";
    },
    watch: "训练耗时异常升高，先怀疑数据加载和通信开销，而不是模型本身变复杂了。",
    link: ["timing_s/step", "timing_s/outer_gen"],
  });

  def({
    k: "dynsam/passrate/zero", zh: "零分题占比", unit: "pct",
    one: "n 次全错的题。这类题产生不了梯度，算力白烧。",
    what: "16 次采样全部答错的题占比。在 GRPO 这类方法里，advantage 用组内相对值算：" +
          "advantage = (本条得分 − 组内均值) / 组内标准差。全错时组内方差为 0，" +
          "advantage 恒为 0，梯度也为 0——题做了，参数没动。",
    read: "纵轴是占比，横轴是 step。这个数越低越好，但它不是 0 反而说明题库有难度梯度。" +
          "真正浪费的是高且不降的情况。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在 " + pct(c.last) + " 的题 16 次全错，最近一步" + trend(c) + "。";
      s += "这部分题对训练没有贡献，动态采样（dynsam）的作用就是把它们过滤掉。";
      return s;
    },
    watch: "零分率长期居高不下，说明题库对当前模型太难，或者判分过严。" +
           "理想状态是随训练推进缓慢下降——模型把能学会的学会了。",
    link: ["dynsam/passrate/one", "dynsam/avg@n", "dynsam/num_measurable"],
  });

  def({
    k: "dynsam/passrate/one", zh: "满分题占比", unit: "pct",
    one: "n 次全对的题。模型早就会了，同样产生不了梯度。",
    what: "16 次采样全部答对的题占比。和零分题对称：全对时组内方差同样为 0，" +
          "advantage 恒为 0，梯度为 0。这类题的算力也是白花的。",
    read: "纵轴是占比，横轴是 step。随训练推进它通常会涨——模型确实学会了更多题。" +
          "但它涨意味着有效样本在减少，所以太高不是好事。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      var s = "现在 " + pct(c.last) + " 的题 16 次全对，最近一步" + trend(c) + "。";
      if (c.zero != null) {
        var eff = 1 - c.last - c.zero;
        s += "扣掉零分和满分，真正有区分度的题只剩约 " + pct(Math.max(0, eff)) +
             "，这部分才是推动参数更新的有效样本。";
      }
      return s;
    },
    watch: "零分率 + 满分率越高，有效样本越少、浪费的算力越多。" +
           "这就是动态采样要解决的问题：只对有区分度的样本训练，用覆盖度换样本效率。",
    link: ["dynsam/passrate/zero", "dynsam/avg@n"],
  });

  def({
    k: "dynsam/infra_error/seq_rate", zh: "基础设施故障率", unit: "pct",
    one: "不是模型的错，但会污染统计数据。",
    what: "因沙箱崩溃、判分超时、网络抖动等基础设施问题而作废的序列占比。" +
          "几万个沙箱并行跑，按概率每天必然会有硬件或网络故障，所以这个数不会是 0。",
    read: "纵轴是占比，横轴是 step。孤立尖峰通常是一次性抖动；平台期抬升说明环境本身出了问题。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "现在 " + pct(c.last) + " 的序列因为基础设施问题作废，最近一步" + trend(c) +
             "。这些序列会被剔除后再算通过率，否则会把环境故障误判成模型答错。";
    },
    watch: "这个数涨上去，通过率就会被低估。所以看通过率时要确认它是否稳定——" +
           "也有专门的排障版本指标（avg@n_no_infra）用于对照。",
    link: ["dynsam/avg@n", "dynsam/num_measurable", "env/active"],
  });

  def({
    k: "env/active", zh: "活跃沙箱数", unit: "int",
    one: "「生成是吞吐瓶颈」最直观的证据。",
    what: "同时在跑的沙箱环境数量。每条轨迹都要一个独立环境来执行命令、看结果，" +
          "所以并发规模直接决定 rollout 能多快做完。",
    read: "纵轴是环境数，横轴是 step。曲线的高位平台就是满负荷运行；掉下来通常是在收尾或遇到了故障。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "现在有 " + big(c.last) + " 个沙箱在并行跑。" +
             "这几万个环境同时解码，是单步要几小时、也是账单这么高的直接原因。";
    },
    watch: "这个数大幅下滑说明并发没跑满，生成会变慢，进而拖长单步耗时。",
    link: ["timing_s/outer_gen", "dynsam/infra_error/seq_rate"],
  });

  def({
    k: "partial/avg_staleness", zh: "平均策略陈旧度", unit: "num",
    one: "异步训练换来的效率，代价就是它。TIS 用来校正。",
    what: "生成样本时用的策略版本，与训练时当前版本相差多少代。" +
          "异步 RL 为了不让生成干等训练，会用略旧的权重去采样。" +
          "这就带来分布偏移：采样分布不是当前策略的分布，直接用会算错梯度。",
    read: "纵轴是相差的代数，横轴是 step。数值越小越接近严格 on-policy（用当前策略采样），" +
          "但越小也意味着生成和训练耦合得越紧、越难并行。这是个取舍。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "平均相差 " + num(c.last, 2) + " 代，最近一步" + trend(c) +
             "。用截断重要性采样（TIS）校正这个偏移：按新旧概率比加权，并截断掉比值过大的样本，" +
             "避免个别极端比值把梯度带偏。";
    },
    watch: "陈旧度持续增大，说明生成和训练的节奏越拉越开，TIS 的截断会丢掉更多样本，" +
           "等效于有效样本量下降。",
    link: ["train_infer_diff/new_infer/kl", "timing_s/outer_gen"],
  });

  def({
    k: "dynsam/num_measurable", zh: "可测量题数", unit: "int",
    one: "这一步真正拿到有效分数的题有多少。",
    what: "本步真正拿到有效通过率的题目数量，排除了基础设施失败、判分出错等无效样本。" +
          "它比「总共出了多少题」更能反映这一步训练实际用了多少有效样本。",
    read: "纵轴是题数，横轴是 step。它和训练批大小（num_target）应当接近若即若离：" +
          "差得多说明无效样本多。",
    now: function (c) {
      if (c.last == null) return "当前没有读到数据。";
      return "本步有 " + big(c.last) + " 道题拿到了有效分数。这是进入参数更新的实际样本量。";
    },
    watch: "可测量题数明显少于训练批大小，说明大量算力花在了拿不到分数的题上，" +
           "可以对照基础设施故障率和零分率定位原因。",
    link: ["dynsam/infra_error/seq_rate", "dynsam/passrate/zero", "dynsam/avg@n"],
  });

  /* ================================================================
     图表与面板（点标题旁的「?」打开）
     ================================================================ */

  G.modules = {
    headline: {
      zh: "核心指标曲线", sub: "dynsam/avg@n",
      body: "这是整块看板的主线：每道题采样 16 次后答对次数的占比，对所有题取平均。\n\n" +
            "横轴是训练步，纵轴是通过率。两条线是 pro 和 flash 两个独立训练任务——" +
            "它们用同一套方法、不同配置同时跑，可以互相印证：如果一个涨一个跌，" +
            "更可能是各自的数据或配置问题；如果同向变化，更可能是方法本身在起作用。\n\n" +
            "单步抖动 1～2 个百分点是正常的，因为每步换一批新题。要看三五步连起来的斜率。",
      link: ["dynsam/avg@n", "dynsam/passrate/zero", "dynsam/passrate/one"],
    },
    bench: {
      zh: "离线评测", sub: "训练过程中定期跑的标准题库",
      body: "离线评测是在训练过程中，定期把中间存档点（checkpoint）拿去跑标准题库得到的分数。\n\n" +
            "它和训练曲线是两回事：训练分数用的是模型自己生成的数据、训练时就在优化的目标；" +
            "离线评测用的是从没训练过的固定题目，不参与任何梯度更新。所以它是独立的泛化检验——" +
            "训练分数涨、这里不涨，说明模型在适应训练分布，而不是真的变强了。\n\n" +
            "之所以要多个基准，是因为单一基准会被刷分：公开题库的题目可能进了预训练语料，" +
            "分数虚高。私有题集用来交叉验证。不同基准涨落不同步是正常的，" +
            "它们考察的能力本来就不一样。",
      link: ["dynsam/avg@n", "critic/rewards/mean"],
    },
    comp: {
      zh: "训练样本构成", sub: "每一步真正进入训练的 prompt 来自哪些任务类别",
      body: "这张堆叠面积图回答：每一步拿去更新参数的训练样本，按任务类别（代码、通用、" +
            "网络安全、视觉、对话）各占多少。\n\n" +
            "纵轴是 prompt 数量（或占比），每个色带是一类，色带的厚度就是它这一步贡献的样本量。" +
            "色带厚度的变化反映动态采样在起作用：某类题如果全对或全错的比例升高，" +
            "它对训练的实际贡献就会下降。\n\n" +
            "这个数不是直接上报的，是从数据源池的存量变化推出来的——" +
            "池子满足「本步留存 = 上步留存 + 本步新接受 − 本步已训练」，反解出训练量。" +
            "重启后的那几步推算不出精确值，会按比例估算并标 ≈。",
      link: ["dynsam/passrate/zero", "dynsam/passrate/one", "dynsam/num_measurable"],
    },
    ds: {
      zh: "数据源分布", sub: "按任务类别统计的活跃数据集",
      body: "列出当前参与训练的数据集，按任务类别分组，并给出每个数据集的题目数量。\n\n" +
            "它和「训练样本构成」的区别：这里看的是题库里有什么（静态的供给），" +
            "构成图看的是实际拿去训练了什么（动态筛选后的结果）。两者对比能看出动态采样" +
            "偏向了哪些数据集。",
      link: ["dynsam/num_measurable"],
    },
    events: {
      zh: "步事件流", sub: "step 完成 / 重启",
      body: "按时间倒序列出这个 run 上发生的事：某一步完成、某一步重启、进度更新等。\n\n" +
            "出现「重启」不用慌：模型权重是周期性存档的，重启只是回到上一个存档点继续，" +
            "之前学到的都还在。真正的代价是时间——从存档点重新跑一遍生成要花几小时。\n\n" +
            "重启次数本身是系统可靠性的指标：几千张 GPU 按概率每天必然有硬件或网络故障，" +
            "所以工程上不追求不崩，而是假定一定会崩，用自动拉起来兜底。",
      link: ["timing_s/step", "dynsam/avg@n"],
    },
    notices: {
      zh: "官方公告", sub: "trainer 运行中断与恢复记录",
      body: "上游主动发布的运营公告，通常是训练中断、维护、参数调整这类事件的说明。\n\n" +
            "它和事件流的区别：事件流是系统自动记录的流水，公告是人工发布的解释。" +
            "看到异常数据先看这里，往往已经有说明。",
      link: ["timing_s/step"],
    },
    runs: {
      zh: "训练任务状态卡", sub: "pro 与 flash 两个 run",
      body: "每个 run 一张卡，显示当前步数、进度、成绩、花费与一些关键配置。\n\n" +
            "「训练批 × n」是本步的训练批大小乘以每道题的采样次数——两者的乘积约等于" +
            "本步生成的轨迹总数。「vs 首步」是当前成绩相对第一步的累计变化，" +
            "比单步涨跌更能说明长期趋势。\n\n" +
            "pro 和 flash 是两个独立训练任务，用同一套方法、不同配置同时跑，" +
            "互为对照实验。",
      link: ["dynsam/avg@n", "perf/total_num_tokens"],
    },
    metrics: {
      zh: "训练指标全景", sub: "官方精选的 18 项训练指标",
      body: "这 18 项是上游 pinned（置顶）出来的核心监控指标，分成几类：\n\n" +
            "训练健康度——策略熵、策略梯度损失、梯度范数、推理/训练 KL、平均奖励。\n" +
            "规模与成本——上下文长度、交互轮数、训练 token 量、耗时拆解。\n" +
            "样本质量——零分率、满分率、基础设施故障率、可测量题数。\n" +
            "并发与异步——活跃沙箱数、策略陈旧度。\n\n" +
            "每张卡片点一下就能打开这个指标的完整讲解：它是什么、图怎么看、" +
            "现在的数在说什么、什么情况要警惕、和哪些指标相关。",
      link: ["dynsam/avg@n"],
    },
  };

  /* 指标库里没有专门词条的指标：按路径前缀给一个通用讲解 */
  G.fallback = function (key) {
    var rules = [
      [/^timing_s\//, "耗时类指标", "单位通常是秒（这里会换算成小时）。它衡量某个阶段花了多少墙钟时间，" +
        "用来定位瓶颈：哪个阶段占大头，优化哪里收益最大。"],
      [/^dynsam\/passrate\//, "通过率分布类指标", "按通过率分档统计题目占比。分档是为了看清样本结构：" +
        "集中在两端（全对/全错）说明有效样本少，集中在中间说明难度合适。"],
      [/^dynsam\//, "动态采样相关指标", "动态采样（dynamic sampling）负责筛掉产生不了梯度的题。" +
        "这类指标描述筛选前后的样本构成与规模。"],
      [/^actor\//, "策略侧指标", "与策略网络（actor，负责生成动作/token 的模型）相关的训练量：" +
        "损失、熵、梯度等，用来监控更新过程是否稳定。"],
      [/^critic\//, "价值/奖励侧指标", "与奖励计算相关的量。注意奖励可能含人为附加项，" +
        "所以这类指标不完全等同于答对率。"],
      [/^train_infer_diff\//, "一致性校准指标", "对比推理引擎与训练框架的计算结果。" +
        "异步 RL 把生成和训练拆到两套系统里，必须持续校准两者的数值一致性。"],
      [/^env\//, "环境侧指标", "沙箱环境的规模与健康度。几万个环境并行是 rollout 并发的基础。"],
      [/^perf\//, "性能与吞吐指标", "token 量、吞吐、耗时这类反映算力开销的量，与账单直接相关。"],
      [/^partial\//, "异步训练相关指标", "异步流水线带来的策略版本偏移及其校正相关的量。"],
      [/^ctx_/, "上下文长度指标", "序列长度相关的统计。attention 的代价是长度的平方级，" +
        "所以长度直接决定显存与耗时。"],
      [/^penalty\//, "惩罚项指标", "对特定行为（如超长、格式错误、重复）施加的惩罚统计，" +
        "用来约束模型不要钻规则的空子。"],
    ];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0].test(key)) return { zh: rules[i][1], body: rules[i][2] };
    }
    return {
      zh: "未分类指标",
      body: "这个指标没有专门的讲解条目。可以按名字猜它的含义：" +
            "timing 开头是耗时，rate/ratio 是比率，mean 是均值，num/count 是数量，" +
            "norm 是范数，kl 是分布差异。",
    };
  };

  global.GLOSSARY = G;
})(typeof window !== "undefined" ? window : this);
