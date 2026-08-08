/* SAWA — shared interactions (nav, mobile menu, scroll reveal, progress bars,
   accordion, tabs, copy buttons). Safe to load on every page. */
(function(){
  /* nav shadow on scroll */
  var nav=document.getElementById('nav');
  if(nav){
    var onScroll=function(){nav.classList.toggle('tight',window.scrollY>20);};
    window.addEventListener('scroll',onScroll,{passive:true});onScroll();
  }

  /* mobile overlay */
  var ov=document.getElementById('overlay');
  var open=document.getElementById('open');
  var close=document.getElementById('close');
  if(ov&&open){
    /* The overlay is always in the DOM. CSS visibility keeps a closed menu out
       of the tab order; `inert` does the same for browsers that support it and
       also blocks it from search-within-page. aria-expanded tells assistive
       tech what the hamburger actually does, and focus is moved into and back
       out of the menu so a keyboard user isn't stranded behind it. */
    var setOpen=function(isOpen){
      ov.classList.toggle('open',isOpen);
      open.setAttribute('aria-expanded',isOpen?'true':'false');
      if('inert' in HTMLElement.prototype)ov.inert=!isOpen;
      document.body.style.overflow=isOpen?'hidden':'';
    };
    open.setAttribute('aria-expanded','false');
    if('inert' in HTMLElement.prototype)ov.inert=true;
    open.onclick=function(){setOpen(true);if(close)close.focus();};
    /* Focus moves back to the hamburger BEFORE the overlay is hidden. Doing it
       the other way round leaves activeElement on the close button inside an
       inert, invisible container, and the next Tab restarts from the top of the
       document. */
    var closeMenu=function(){open.focus();setOpen(false);};
    if(close)close.onclick=closeMenu;
    /* Links navigate away, so returning focus to the hamburger would fight the
       page load — just close, without the focus restore. */
    ov.querySelectorAll('a').forEach(function(a){a.onclick=function(){setOpen(false);};});
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape'&&ov.classList.contains('open'))closeMenu();
    });
  }

  /* reveal + fill bars */
  if('IntersectionObserver' in window){
    /* A ratio alone cannot judge a block taller than the window. The legal
       pages are one .rv element about 19,000px high, so 16% of it is roughly
       3,000px — more than the viewport can ever show — and the callback never
       fired: the whole policy sat at opacity 0. Watch ratio 0 as well, and
       reveal on whichever comes first, 16% of the element or 16% of the
       window's worth of it. */
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(!e.isIntersecting)return;
        if(e.intersectionRatio<.16&&e.intersectionRect.height<window.innerHeight*.16)return;
        e.target.classList.add('in');
        e.target.querySelectorAll('[data-fill]').forEach(function(b){b.style.width=b.dataset.fill;});
        io.unobserve(e.target);
      });
    },{threshold:[0,.16],rootMargin:'0px 0px -7% 0px'});
    document.querySelectorAll('.rv').forEach(function(el){io.observe(el);});
  } else {
    document.querySelectorAll('.rv').forEach(function(el){el.classList.add('in');});
    document.querySelectorAll('[data-fill]').forEach(function(b){b.style.width=b.dataset.fill;});
  }

  /* fire above-the-fold bars early */
  setTimeout(function(){
    document.querySelectorAll('.phero [data-fill],.early [data-fill]').forEach(function(b){b.style.width=b.dataset.fill;});
  },500);

  /* tabs — this file owns the visual state only. Pages that need a tab to DO
     something listen for the 'tabchange' event it emits (see departures.html);
     previously the highlight was all there was, so the departures filters and
     sort controls looked interactive but changed nothing. */
  document.querySelectorAll('[data-tabs]').forEach(function(group){
    var tabs=group.querySelectorAll('.tab');
    tabs.forEach(function(t){
      if(!t.hasAttribute('role'))t.setAttribute('role','tab');
      t.setAttribute('aria-selected',t.classList.contains('on')?'true':'false');
      t.onclick=function(){
        tabs.forEach(function(x){x.classList.remove('on');x.setAttribute('aria-selected','false');});
        t.classList.add('on');t.setAttribute('aria-selected','true');
        group.dispatchEvent(new CustomEvent('tabchange',{
          bubbles:true,
          detail:{tab:t,value:t.getAttribute('data-value')||(t.textContent||'').trim()}
        }));
      };
    });
  });

  /* accordion */
  document.querySelectorAll('.acc .q').forEach(function(q){
    q.onclick=function(){
      var item=q.closest('.item');
      var a=item.querySelector('.a');
      var isOpen=item.classList.contains('open');
      if(isOpen){item.classList.remove('open');a.style.maxHeight=null;}
      else{item.classList.add('open');a.style.maxHeight=a.scrollHeight+'px';}
    };
  });

  /* copy buttons — the old version reported "Copied" unconditionally, even when
     navigator.clipboard was absent (it only exists on secure origins) or when
     writeText() rejected. So it could claim success with an empty clipboard.
     Now the label only changes after the copy actually resolves, with a
     execCommand fallback and an honest failure message. */
  function legacyCopy(text){
    var ta=document.createElement('textarea');
    ta.value=text;
    ta.setAttribute('readonly','');
    ta.style.cssText='position:absolute;left:-9999px;top:0';
    document.body.appendChild(ta);
    var selection=document.getSelection();
    var restore=selection.rangeCount>0?selection.getRangeAt(0):null;
    ta.select();
    var ok=false;
    try{ok=document.execCommand('copy');}catch(e){ok=false;}
    document.body.removeChild(ta);
    if(restore){selection.removeAllRanges();selection.addRange(restore);}
    return ok;
  }
  document.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.onclick=function(){
      var target=document.querySelector(btn.getAttribute('data-copy'));
      if(!target)return;
      var text=(target.innerText||target.textContent||'').trim();
      var original=btn.textContent;
      var settle=function(ok){
        btn.textContent=ok?'Copied':'Press ⌘/Ctrl+C';
        setTimeout(function(){btn.textContent=original;},ok?1600:2600);
      };
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){settle(true);},function(){settle(legacyCopy(text));});
      }else{
        settle(legacyCopy(text));
      }
    };
  });
})();
