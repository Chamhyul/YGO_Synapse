(function (root) {
    'use strict';
    // Map the unit card plane into the detected quadrilateral. No OpenCV on
    // the main thread: a 320x220 artwork crop needs only bounded pixel sampling.
    function cardQuad(points, width, height) {
        const p = points.map(point => ({ x: point.x * width, y: point.y * height }));
        const cx = p.reduce((s, v) => s + v.x, 0) / 4, cy = p.reduce((s, v) => s + v.y, 0) / 4;
        p.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
        const start = p.reduce((best, v, i) => v.x + v.y < p[best].x + p[best].y ? i : best, 0);
        let ordered = p.slice(start).concat(p.slice(0, start));
        const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        if (d(ordered[0], ordered[1]) > d(ordered[1], ordered[2])) ordered = [ordered[1], ordered[2], ordered[3], ordered[0]];
        return ordered;
    }
    function projectiveMap(p) {
        const [a, b, c, d] = p;
        const dx1=b.x-c.x, dx2=d.x-c.x, dx3=a.x-b.x+c.x-d.x;
        const dy1=b.y-c.y, dy2=d.y-c.y, dy3=a.y-b.y+c.y-d.y;
        const det=dx1*dy2-dx2*dy1;
        if (Math.abs(det)<1e-8) throw new Error('카드 영역의 꼭짓점을 확인해주세요.');
        const g=(dx3*dy2-dx2*dy3)/det, h=(dx1*dy3-dx3*dy1)/det;
        return (u,v) => { const z=g*u+h*v+1; return {x:((b.x-a.x+g*b.x)*u+(d.x-a.x+h*d.x)*v+a.x)/z,y:((b.y-a.y+g*b.y)*u+(d.y-a.y+h*d.y)*v+a.y)/z}; };
    }
    function cropPixels(source, polygon, pattern, width=320, height=220) {
        const map=projectiveMap(cardQuad(polygon,source.width,source.height));
        const data=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
            const p=map(pattern.x+(x+.5)/width*pattern.width,pattern.y+(y+.5)/height*pattern.height);
            const sx=Math.max(0,Math.min(source.width-1,p.x)),sy=Math.max(0,Math.min(source.height-1,p.y));
            const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(x0+1,source.width-1),y1=Math.min(y0+1,source.height-1),fx=sx-x0,fy=sy-y0;
            for(let c=0;c<3;c++) data[(y*width+x)*4+c]=(source.data[(y0*source.width+x0)*4+c]*(1-fx)+source.data[(y0*source.width+x1)*4+c]*fx)*(1-fy)+(source.data[(y1*source.width+x0)*4+c]*(1-fx)+source.data[(y1*source.width+x1)*4+c]*fx)*fy;
            data[(y*width+x)*4+3]=255;
        }
        return {data,width,height};
    }
    root.PhotoCardGeometry={cardQuad,projectiveMap,cropPixels};
    if(typeof module==='object'&&module.exports) module.exports=root.PhotoCardGeometry;
})(typeof window!=='undefined'?window:globalThis);
