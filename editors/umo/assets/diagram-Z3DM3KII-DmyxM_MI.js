import{p as B}from"./chunk-JWPE2WC7-C2F5AMSy.js";import{_ as u,D as m,G as C,d as S,l as w,b as D,a as T,p as E,q as P,g as z,s as A,A as F,E as W,r as _}from"./index-DAVVF-y8.js";import{p as N}from"./cynefin-OW5HDTMX-LK9We7sT.js";import"./index-DqahM7hF.js";var L=W.packet,b,v=(b=class{constructor(){this.packet=[],this.setAccTitle=D,this.getAccTitle=T,this.setDiagramTitle=E,this.getDiagramTitle=P,this.getAccDescription=z,this.setAccDescription=A}getConfig(){const t=m({...L,...F().packet});return t.showBits&&(t.paddingY+=10),t}getPacket(){return this.packet}pushWord(t){t.length>0&&this.packet.push(t)}clear(){_(),this.packet=[]}},u(b,"PacketDB"),b),M=1e4,Y=u((e,t)=>{B(e,t);let s=-1,o=[],l=1;const{bitsPerRow:c}=t.getConfig();for(let{start:a,end:r,bits:i,label:d}of e.blocks){if(a!==void 0&&r!==void 0&&r<a)throw new Error(`Packet block ${a} - ${r} is invalid. End must be greater than start.`);if(a!=null||(a=s+1),a!==s+1)throw new Error(`Packet block ${a} - ${r!=null?r:a} is not contiguous. It should start from ${s+1}.`);if(i===0)throw new Error(`Packet block ${a} is invalid. Cannot have a zero bit field.`);for(r!=null||(r=a+(i!=null?i:1)-1),i!=null||(i=r-a+1),s=r,w.debug(`Packet block ${a} - ${s} with label ${d}`);o.length<=c+1&&t.getPacket().length<M;){const[p,n]=G({start:a,end:r,bits:i,label:d},l,c);if(o.push(p),p.end+1===l*c&&(t.pushWord(o),o=[],l++),!n)break;({start:a,end:r,bits:i,label:d}=n)}}t.pushWord(o)},"populate"),G=u((e,t,s)=>{if(e.start===void 0)throw new Error("start should have been set during first phase");if(e.end===void 0)throw new Error("end should have been set during first phase");if(e.start>e.end)throw new Error(`Block start ${e.start} is greater than block end ${e.end}.`);if(e.end+1<=t*s)return[e,void 0];const o=t*s-1,l=t*s;return[{start:e.start,end:o,label:e.label,bits:o-e.start},{start:l,end:e.end,label:e.label,bits:e.end-l}]},"getNextFittingBlock"),x={parser:{yy:void 0},parse:u(async e=>{var o;const t=await N("packet",e),s=(o=x.parser)==null?void 0:o.yy;if(!(s instanceof v))throw new Error("parser.parser?.yy was not a PacketDB. This is due to a bug within Mermaid, please report this issue at https://github.com/mermaid-js/mermaid/issues.");w.debug(t),Y(t,s)},"parse")},I=u((e,t,s,o)=>{const l=o.db,c=l.getConfig(),{rowHeight:a,paddingY:r,bitWidth:i,bitsPerRow:d}=c,p=l.getPacket(),n=l.getDiagramTitle(),h=a+r,g=h*(p.length+1)-(n?0:a),k=i*d+2,f=C(t);f.attr("viewBox",`0 0 ${k} ${g}`),S(f,g,k,c.useMaxWidth);for(const[y,$]of p.entries())O(f,$,y,c);f.append("text").text(n).attr("x",k/2).attr("y",g-h/2).attr("dominant-baseline","middle").attr("text-anchor","middle").attr("class","packetTitle")},"draw"),O=u((e,t,s,{rowHeight:o,paddingX:l,paddingY:c,bitWidth:a,bitsPerRow:r,showBits:i})=>{const d=e.append("g"),p=s*(o+c)+c;for(const n of t){const h=n.start%r*a+1,g=(n.end-n.start+1)*a-l;if(d.append("rect").attr("x",h).attr("y",p).attr("width",g).attr("height",o).attr("class","packetBlock"),d.append("text").attr("x",h+g/2).attr("y",p+o/2).attr("class","packetLabel").attr("dominant-baseline","middle").attr("text-anchor","middle").text(n.label),!i)continue;const k=n.end===n.start,f=p-2;d.append("text").attr("x",h+(k?g/2:0)).attr("y",f).attr("class","packetByte start").attr("dominant-baseline","auto").attr("text-anchor",k?"middle":"start").text(n.start),k||d.append("text").attr("x",h+g).attr("y",f).attr("class","packetByte end").attr("dominant-baseline","auto").attr("text-anchor","end").text(n.end)}},"drawWord"),j={draw:I},q={byteFontSize:"10px",startByteColor:"black",endByteColor:"black",labelColor:"black",labelFontSize:"12px",titleColor:"black",titleFontSize:"14px",blockStrokeColor:"black",blockStrokeWidth:"1",blockFillColor:"#efefef"},H=u(({packet:e}={})=>{const t=m(q,e);return`
	.packetByte {
		font-size: ${t.byteFontSize};
	}
	.packetByte.start {
		fill: ${t.startByteColor};
	}
	.packetByte.end {
		fill: ${t.endByteColor};
	}
	.packetLabel {
		fill: ${t.labelColor};
		font-size: ${t.labelFontSize};
	}
	.packetTitle {
		fill: ${t.titleColor};
		font-size: ${t.titleFontSize};
	}
	.packetBlock {
		stroke: ${t.blockStrokeColor};
		stroke-width: ${t.blockStrokeWidth};
		fill: ${t.blockFillColor};
	}
	`},"styles"),J={parser:x,get db(){return new v},renderer:j,styles:H};export{J as diagram};
