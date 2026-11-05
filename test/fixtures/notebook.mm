<?xml version="1.0" encoding="UTF-8"?>
<map version="1.0.1">
<!-- 示例文件：覆盖 FreeMind 常见结构（注释、icon、richcontent、arrowlink、实体、零宽字符、缩进不一致），供测试使用 -->
<node TEXT="读书笔记" ID="ID_root" VGAP="6" STYLE="bubble">
  <node TEXT="技术" ID="ID_tech" POSITION="right">
    <node TEXT="编程语言" ID="ID_lang">
      <node TEXT="TypeScript" ID="ID_ts"/>
      <node ID="ID_go" TEXT="Go"/>
      <node TEXT="Rust"><icon BUILTIN="bookmark"/></node>
      <node TEXT="SQL">
        <arrowlink DESTINATION="ID_ts" STARTARROW="Default" ENDARROW="Default"/>
      </node>
    </node>
    <node TEXT="数据库" ID="ID_db">
      <node TEXT="PostgreSQL" ID="ID_pg"/>
      <node TEXT="Redis" ID="ID_redis"/>
      <node ID="ID_es" TEXT="Elasticsearch" LINK="https://example.com/es">
        <richcontent TYPE="NOTE"><html><head></head><body><p>倒排索引与分词</p></body></html></richcontent>
      </node>
    </node>
    <node TEXT="网络" ID="ID_net">
      <node TEXT="TCP/IP" ID="ID_tcp"/>
      <node TEXT="HTTP/2" ID="ID_h2"/>
      <node TEXT="QUIC" ID="ID_quic"/>
    </node>
    <node TEXT="工具链" ID="ID_tools">
      <node TEXT="Git" ID="ID_git"/>
      <node TEXT="Docker" ID="ID_docker"/>
      <node TEXT="Make" ID="ID_make"/>
    </node>
  </node>
  <node TEXT="管理" ID="ID_mgmt" POSITION="left">
	<node TEXT="需求" ID="ID_req">
		<node TEXT="用户故事" ID="ID_story"/>
		<node TEXT="验收标准" ID="ID_ac"/>
		<node TEXT="优先级" ID="ID_prio"/>
	</node>
	<node TEXT="排期" ID="ID_plan">
		<node TEXT="里程碑" ID="ID_mile"/>
		<node TEXT="缓冲" ID="ID_buffer"/>
	</node>
	<node TEXT="复盘" ID="ID_review" FOLDED="true">
		<node TEXT="做得好" ID="ID_good"/>
		<node TEXT="待改进" ID="ID_bad"/>
	</node>
  </node>
  <node TEXT="写作">
    <node TEXT="结构" ID="ID_struct">
      <node TEXT="开头" ID="ID_open"/>
      <node TEXT="论证" ID="ID_argue"/>
      <node TEXT="结尾" ID="ID_end"/>
    </node>
    <node TEXT="素材">
      <node TEXT="案例" ID="ID_case"/>
      <node TEXT="引用" ID="ID_quote"/>
    </node>
  </node>
  <node TEXT="健康">
    <node TEXT="睡眠" ID="ID_sleep">
      <node TEXT="时长" ID="ID_dur"/>
      <node TEXT="规律" ID="ID_rhythm"/>
    </node>
    <node TEXT="运动" ID="ID_sport">
      <node TEXT="有氧" ID="ID_aero"/>
      <node TEXT="力量" ID="ID_strength"/>
    </node>
  </node>
  <node TEXT="杂项" ID="ID_misc">
    <node TEXT="复盘 &#10;每周五" ID="ID_nl"/>
    <node TEXT="待办&#x200B;  " ID="ID_zw"/>
    <node TEXT="空节点"></node>
    <node TEXT="A &amp; B &lt; C" ID="ID_amp"/>
  </node>
</node>
</map>
