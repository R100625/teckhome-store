import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CATEGORIES, type Product } from './types'
import { getProducts, getAllProducts, saveProduct, deleteProduct, toggleFeatured } from './storage'

type Bindings = {
  PRODUCTS_KV: KVNamespace
  ARTICLES_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// Helper para KV
function getKV(c: any): KVNamespace | null {
  try {
    return c.env?.PRODUCTS_KV || null
  } catch {
    return null
  }
}

// === API ROUTES ===

// Listar categorias
app.get('/api/categories', (c) => {
  return c.json(CATEGORIES)
})

// Listar produtos de uma categoria
app.get('/api/products/:categoryId', async (c) => {
  const { categoryId } = c.req.param()
  const kv = getKV(c)
  const products = await getProducts(kv, categoryId)
  return c.json(products)
})

// Listar todos os produtos
app.get('/api/products', async (c) => {
  const kv = getKV(c)
  const products = await getAllProducts(kv)
  return c.json(products)
})

// Buscar metadados de URL (Open Graph scraping)
app.post('/api/fetch-metadata', async (c) => {
  try {
    const { url } = await c.req.json()
    if (!url) return c.json({ error: 'URL obrigatória' }, 400)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TeckhomeBot/1.0)',
        'Accept': 'text/html'
      },
      redirect: 'follow'
    })

    const html = await response.text()

    const getMetaContent = (property: string): string => {
      const patterns = [
        new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
        new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
      ]
      for (const re of patterns) {
        const m = html.match(re)
        if (m) return m[1].trim()
      }
      return ''
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = getMetaContent('og:title') || getMetaContent('twitter:title') || (titleMatch ? titleMatch[1].trim() : '') || 'Produto'
    const description = getMetaContent('og:description') || getMetaContent('description') || ''
    const imageUrl = getMetaContent('og:image') || getMetaContent('twitter:image') || ''

    // Tenta extrair preço
    const pricePatterns = [
      /R\$\s*[\d.,]+/gi,
      /"price":\s*"?([\d.,]+)"?/i,
      /data-price=["']([\d.,]+)["']/i
    ]
    let price = ''
    for (const pattern of pricePatterns) {
      const m = html.match(pattern)
      if (m) {
        price = m[0].replace(/"price":\s*"?/, 'R$ ').replace(/"?$/, '')
        break
      }
    }

    // Detecta loja
    const hostname = new URL(url).hostname.replace('www.', '')
    const storeMap: Record<string, string> = {
      'amazon.com.br': 'Amazon',
      'mercadolivre.com.br': 'Mercado Livre',
      'shopee.com.br': 'Shopee',
      'americanas.com.br': 'Americanas',
      'magazineluiza.com.br': 'Magazine Luiza',
      'casasbahia.com.br': 'Casas Bahia',
      'pontofrio.com.br': 'Ponto Frio',
      'extra.com.br': 'Extra',
      'submarino.com.br': 'Submarino',
      'kabum.com.br': 'KaBuM',
      'fastshop.com.br': 'FastShop',
      'aliexpress.com': 'AliExpress'
    }
    const store = storeMap[hostname] || hostname

    return c.json({ title, description, imageUrl, price, store, url })
  } catch (e) {
    return c.json({ error: 'Falha ao buscar metadados', title: '', description: '', imageUrl: '', price: '', store: '' }, 200)
  }
})

// Adicionar produto
app.post('/api/products', async (c) => {
  try {
    const body = await c.req.json()
    const { categoryId, title, description, imageUrl, productUrl, price, store } = body

    if (!categoryId || !productUrl) {
      return c.json({ error: 'categoryId e productUrl são obrigatórios' }, 400)
    }

    const cat = CATEGORIES.find(c => c.id === categoryId)
    if (!cat) return c.json({ error: 'Categoria inválida' }, 400)

    const product: Product = {
      id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      categoryId,
      title: title || 'Produto sem título',
      description: description || '',
      imageUrl: imageUrl || '',
      productUrl,
      price: price || '',
      store: store || '',
      rating: body.rating || 0,
      featured: false,
      createdAt: new Date().toISOString()
    }

    const kv = getKV(c)
    await saveProduct(kv, product)

    return c.json({ success: true, product }, 201)
  } catch (e) {
    return c.json({ error: 'Erro ao salvar produto' }, 500)
  }
})

// Atualizar produto
app.put('/api/products/:categoryId/:productId', async (c) => {
  try {
    const { categoryId, productId } = c.req.param()
    const body = await c.req.json()
    const kv = getKV(c)

    const products = await getProducts(kv, categoryId)
    const product = products.find(p => p.id === productId)
    if (!product) return c.json({ error: 'Produto não encontrado' }, 404)

    const updated = { ...product, ...body, id: productId, categoryId }
    await saveProduct(kv, updated)

    return c.json({ success: true, product: updated })
  } catch (e) {
    return c.json({ error: 'Erro ao atualizar produto' }, 500)
  }
})

// Deletar produto
app.delete('/api/products/:categoryId/:productId', async (c) => {
  const { categoryId, productId } = c.req.param()
  const kv = getKV(c)
  const ok = await deleteProduct(kv, categoryId, productId)

  if (!ok) return c.json({ error: 'Produto não encontrado' }, 404)
  return c.json({ success: true })
})

// Toggle destaque
app.patch('/api/products/:categoryId/:productId/featured', async (c) => {
  const { categoryId, productId } = c.req.param()
  const kv = getKV(c)
  const product = await toggleFeatured(kv, categoryId, productId)
  if (!product) return c.json({ error: 'Produto não encontrado' }, 404)
  return c.json({ success: true, product })
})

// Favicon (evita 404 em logs)
app.get('/favicon.ico', (c) => {
  return new Response(null, { status: 204 })
})

// === PÁGINA PRINCIPAL ===
app.get('/', (c) => {
  return c.html(homePage())
})

// === PÁGINA DE CATEGORIA ===
app.get('/categoria/:id', (c) => {
  const { id } = c.req.param()
  const cat = CATEGORIES.find(cat => cat.id === id)
  if (!cat) return c.redirect('/')
  return c.html(categoryPage(cat.id))
})

// === AUTH ADMIN ===
const ADMIN_USER = 'teckhome_admin'
const ADMIN_PASS = 'TeckHome@2025#Store'
const COOKIE_NAME = 'teckhome_auth'
const COOKIE_VALUE = 'granted'

function isAuthenticated(c: any): boolean {
  const cookieHeader = c.req.header('Cookie') || ''
  return cookieHeader.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`)
}

app.get('/admin', (c) => {
  if (!isAuthenticated(c)) return c.html(loginPage())
  return c.html(adminPage())
})

app.post('/admin/login', async (c) => {
  const body = await c.req.parseBody()
  const username = body['username'] as string
  const password = body['password'] as string
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const res = c.redirect('/admin')
    res.headers.set('Set-Cookie', `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; Max-Age=86400; SameSite=Strict`)
    return res
  }
  return c.html(loginPage('Usuário ou senha inválidos. Tente novamente.'))
})

app.get('/admin/logout', (c) => {
  const res = c.redirect('/')
  res.headers.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict`)
  return res
})

// === API: ARTIGOS DO BLOG ===

// Listar artigos
app.get('/api/articles', async (c) => {
  try {
    const kv = c.env?.ARTICLES_KV
    if (!kv) return c.json([])
    const list = await kv.list({ prefix: 'article_' })
    const articles = await Promise.all(
      list.keys.map(async (k: any) => {
        const val = await kv.get(k.name)
        return val ? JSON.parse(val) : null
      })
    )
    const valid = articles.filter(Boolean).sort((a: any, b: any) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    return c.json(valid)
  } catch {
    return c.json([])
  }
})

// Criar artigo a partir de URL de produto
app.post('/api/articles', async (c) => {
  try {
    if (!isAuthenticated(c)) return c.json({ error: 'Não autorizado' }, 401)
    const body = await c.req.json()
    const { title, excerpt, content, category, categoryIcon, image, productUrl, store, readTime, keywords } = body
    if (!title) return c.json({ error: 'Título obrigatório' }, 400)

    const id = `article_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const slug = title.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60)

    const article = {
      id,
      slug,
      title,
      excerpt: excerpt || '',
      content: content || '',
      category: category || 'Geral',
      categoryIcon: categoryIcon || '📝',
      image: image || '',
      productUrl: productUrl || '',
      store: store || '',
      readTime: readTime || '5 min',
      keywords: keywords || '',
      url: `/artigo/${slug}`,
      createdAt: new Date().toISOString()
    }

    const kv = c.env?.ARTICLES_KV
    if (kv) await kv.put(id, JSON.stringify(article))

    return c.json({ success: true, article }, 201)
  } catch (e) {
    return c.json({ error: 'Erro ao criar artigo' }, 500)
  }
})

// Deletar artigo
app.delete('/api/articles/:id', async (c) => {
  try {
    if (!isAuthenticated(c)) return c.json({ error: 'Não autorizado' }, 401)
    const { id } = c.req.param()
    const kv = c.env?.ARTICLES_KV
    if (kv) await kv.delete(id)
    return c.json({ success: true })
  } catch {
    return c.json({ error: 'Erro ao deletar artigo' }, 500)
  }
})

// === PÁGINAS INFORMATIVAS ===
app.get('/termos-de-uso', (c) => {
  return c.html(termosPage())
})

app.get('/politica-de-privacidade', (c) => {
  return c.html(privacidadePage())
})

app.get('/politica-de-cookies', (c) => {
  return c.html(cookiesPage())
})

app.get('/sobre', (c) => {
  return c.html(sobrePage())
})

// === HTML PAGES ===

function homePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeckHome Store — Reviews, Comparativos e Melhores Produtos para sua Casa</title>
  <meta name="description" content="TeckHome Store: reviews honestos, comparativos e recomendações dos melhores produtos de tecnologia, eletrodomésticos, refrigeração, ventilação e jardim. Descubra antes de comprar!">
  <meta name="keywords" content="reviews de produtos, melhores eletrodomésticos, tecnologia para casa, comparativo de produtos, eletrônicos, refrigeração, ventilação, jardim, TeckHome Store">
  <meta name="robots" content="index, follow">
  <meta name="author" content="Equipe TeckHome">
  <link rel="canonical" href="https://teckhomestore.com/">
  <meta property="og:title" content="TeckHome Store — Descubra antes de comprar">
  <meta property="og:description" content="Reviews honestos e recomendações dos melhores produtos para sua casa e tecnologia. Análises imparciais da Equipe TeckHome.">
  <meta property="og:image" content="https://teckhomestore.com/static/logo.png">
  <meta property="og:url" content="https://teckhomestore.com">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="TeckHome Store — Reviews e Comparativos">
  <meta name="twitter:description" content="Descubra os melhores produtos antes de comprar. Reviews imparciais da Equipe TeckHome.">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"TeckHome Store","url":"https://teckhomestore.com","description":"Portal de reviews, comparativos e recomendações de produtos de tecnologia e utilidades para o lar","potentialAction":{"@type":"SearchAction","target":"https://teckhomestore.com/?q={search_term_string}","query-input":"required name=search_term_string"}}</script>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .gradient-hero { background: linear-gradient(135deg, #0f0c29 0%, #1e1b4b 25%, #302b63 60%, #1a1a2e 100%); }
    .card-hover { transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
    .card-hover:hover { transform: translateY(-10px); box-shadow: 0 30px 60px rgba(99,102,241,0.18); }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .category-card:hover .category-icon { transform: scale(1.2) rotate(5deg); }
    .category-icon { transition: transform 0.3s ease; display: inline-block; }
    .search-box:focus { box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.25); }
    .pulse-dot { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    @keyframes gradientMove { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes floatAnim { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
    .fade-in-up { animation: fadeInUp 0.7s ease forwards; }
    .float-anim { animation: floatAnim 4s ease-in-out infinite; }
    .editorial-footer { background: linear-gradient(135deg, #f8faff, #eef2ff); border-top: 1px solid #e0e7ff; }
    .editorial-footer:hover { background: linear-gradient(135deg, #eef2ff, #e0e7ff); }
    .blog-card:hover { transform: translateY(-6px); box-shadow: 0 20px 40px rgba(99,102,241,0.15); }
    .blog-card { transition: all 0.3s ease; }
    .trust-badge { background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 1px solid #bbf7d0; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 4px; }
    .nav-link { position: relative; }
    .nav-link::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 0; height: 2px; background: #6366f1; transition: width 0.3s; }
    .nav-link:hover::after { width: 100%; }
    .hero-glow { box-shadow: 0 0 80px rgba(99,102,241,0.4), 0 0 160px rgba(56,189,248,0.2); }
    .stat-counter { background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05)); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.15); }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Descubra antes de comprar</span>
          </div>
        </a>
        <div class="hidden md:flex items-center gap-6">
          <a href="/" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Início</a>
          <a href="#destaques" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Destaques</a>
          <a href="#categorias" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Categorias</a>
          <a href="#blog" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Blog</a>
          <a href="/admin" class="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-indigo-700 transition-colors flex items-center gap-2">
            <i class="fas fa-plus text-xs"></i> Adicionar Produto
          </a>
        </div>
        <button id="mobileMenuBtn" class="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100">
          <i class="fas fa-bars"></i>
        </button>
      </div>
    </div>
    <!-- Mobile menu -->
    <div id="mobileMenu" class="hidden md:hidden border-t border-gray-100 bg-white px-4 pb-4">
      <div class="flex flex-col gap-3 pt-3">
        <a href="/" class="text-sm font-medium text-gray-700 py-2">Início</a>
        <a href="#categorias" class="text-sm font-medium text-gray-700 py-2">Categorias</a>
        <a href="#destaques" class="text-sm font-medium text-gray-700 py-2">Destaques</a>
        <a href="/admin" class="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-xl text-center">+ Adicionar Produto</a>
      </div>
    </div>
  </nav>

  <!-- HERO -->
  <section class="gradient-hero text-white py-20 md:py-28 px-4 relative overflow-hidden">
    <!-- Efeitos de fundo -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute -top-32 -right-32 w-96 h-96 bg-indigo-500 rounded-full opacity-15 blur-3xl"></div>
      <div class="absolute -bottom-32 -left-32 w-96 h-96 bg-blue-500 rounded-full opacity-10 blur-3xl"></div>
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-600 rounded-full opacity-5 blur-3xl"></div>
      <!-- Grid pattern -->
      <div class="absolute inset-0 opacity-5" style="background-image: linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px); background-size: 50px 50px;"></div>
    </div>

    <div class="max-w-5xl mx-auto text-center relative z-10">

      <!-- Badge de confiança -->
      <div class="inline-flex items-center gap-2 bg-white/10 backdrop-blur-md rounded-full px-5 py-2 text-sm mb-8 border border-white/20 fade-in-up">
        <span class="pulse-dot w-2 h-2 bg-green-400 rounded-full"></span>
        <span class="font-medium">Reviews honestos · Análises imparciais · Atualizado 2026</span>
      </div>

      <!-- Logo + Título -->
      <div class="flex flex-col items-center gap-6 mb-8 fade-in-up">
        <div class="relative float-anim">
          <img src="/static/logo.png" alt="TeckHome Store — Reviews e Comparativos de Produtos" class="w-28 h-28 md:w-36 md:h-36 rounded-3xl object-cover shadow-2xl border-2 border-white/20 hero-glow">
          <div class="absolute -bottom-2 -right-2 bg-green-400 w-6 h-6 rounded-full border-2 border-white flex items-center justify-center">
            <i class="fas fa-check text-white text-xs"></i>
          </div>
        </div>
        <div>
          <h1 class="text-5xl md:text-7xl font-black leading-tight tracking-tight">
            Teck<span class="text-indigo-300">Home</span> Store
          </h1>
          <p class="text-xl md:text-2xl text-indigo-200 font-semibold mt-3">Descubra antes de comprar. Escolha com confiança.</p>
        </div>
      </div>

      <!-- Subtítulo persuasivo -->
      <p class="text-base md:text-xl text-indigo-100/90 mb-10 max-w-2xl mx-auto leading-relaxed fade-in-up">
        Pare de desperdiçar dinheiro em produtos que decepcionam. Nossa equipe analisa, compara e recomenda <strong class="text-white">somente o que realmente vale a pena</strong> — para você comprar com segurança.
      </p>

      <!-- Barra de busca -->
      <div class="max-w-xl mx-auto relative mb-10 fade-in-up">
        <input
          id="searchInput"
          type="text"
          placeholder="🔍  Buscar produtos, categorias..."
          class="search-box w-full py-4 px-6 pr-16 rounded-2xl text-gray-800 text-sm font-medium bg-white shadow-2xl outline-none border-2 border-transparent focus:border-indigo-300"
          oninput="handleSearch(this.value)"
        >
        <button class="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 bg-indigo-600 rounded-xl flex items-center justify-center hover:bg-indigo-700 transition-colors shadow-lg">
          <i class="fas fa-search text-white text-sm"></i>
        </button>
      </div>

      <!-- Stats de confiança -->
      <div class="grid grid-cols-3 gap-3 max-w-md mx-auto fade-in-up">
        <div class="stat-counter rounded-2xl px-3 py-3 text-center">
          <div class="text-2xl font-black text-white">7</div>
          <div class="text-indigo-300 text-xs mt-0.5 font-medium">Categorias</div>
        </div>
        <div class="stat-counter rounded-2xl px-3 py-3 text-center">
          <div class="text-2xl font-black text-white">100%</div>
          <div class="text-indigo-300 text-xs mt-0.5 font-medium">Imparcial</div>
        </div>
        <div class="stat-counter rounded-2xl px-3 py-3 text-center">
          <div class="text-2xl font-black text-white">🔒</div>
          <div class="text-indigo-300 text-xs mt-0.5 font-medium">Verificado</div>
        </div>
      </div>

    </div>
  </section>

  <!-- SEARCH RESULTS -->
  <div id="searchResults" class="hidden max-w-7xl mx-auto px-4 py-8">
    <h2 class="text-xl font-bold text-gray-800 mb-4">Resultados da busca</h2>
    <div id="searchGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"></div>
    <div id="noResults" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-search text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium">Nenhum produto encontrado</p>
    </div>
  </div>

  <!-- DESTAQUES -->
  <section id="destaques" class="bg-white py-16 px-4">
    <div class="max-w-7xl mx-auto">
      <div class="flex items-center justify-between mb-10">
        <div>
          <h2 class="text-3xl font-black text-gray-900 mb-1">Produtos em Destaque</h2>
          <p class="text-gray-500">Os mais recomendados pela nossa equipe</p>
        </div>
        <a href="/admin" class="hidden md:flex items-center gap-2 text-indigo-600 font-semibold hover:text-indigo-800 transition-colors text-sm">
          <i class="fas fa-plus"></i> Adicionar
        </a>
      </div>
      <div id="featuredGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        <div class="shimmer rounded-2xl h-80"></div>
        <div class="shimmer rounded-2xl h-80"></div>
        <div class="shimmer rounded-2xl h-80"></div>
        <div class="shimmer rounded-2xl h-80"></div>
      </div>
      <div id="noFeatured" class="hidden text-center py-16 text-gray-400">
        <i class="fas fa-star text-5xl mb-4 opacity-30"></i>
        <p class="text-lg font-medium mb-2">Nenhum produto em destaque ainda</p>
        <a href="/admin" class="text-indigo-600 font-medium hover:underline">Adicionar produtos agora →</a>
      </div>
    </div>
  </section>

  <!-- CATEGORIAS -->
  <section id="categorias" class="max-w-7xl mx-auto px-4 py-16">
    <div class="text-center mb-12">
      <h2 class="text-3xl font-black text-gray-900 mb-3">Explore por Categoria</h2>
      <p class="text-gray-500 text-lg">Encontre exatamente o que você precisa</p>
    </div>
    <div id="categoriesGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
    </div>
  </section>


  <!-- BLOG -->
  <section id="blog" class="max-w-7xl mx-auto px-4 py-16">
    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-12">
      <div>
        <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Blog TeckHome</span>
        <h2 class="text-3xl font-black text-gray-900 mb-2">Artigos e Guias de Compra</h2>
        <p class="text-gray-500 max-w-xl">Conteúdo especializado para ajudar você a fazer a melhor escolha antes de comprar.</p>
      </div>
    </div>
    <div id="blogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="noBlog" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-newspaper text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium mb-2">Nenhum artigo publicado ainda</p>
      <a href="/admin" class="text-indigo-600 font-medium hover:underline">Criar primeiro artigo →</a>
    </div>
  </section>

  <!-- EQUIPE TECKHOME -->
  <section id="equipe-teckhome" class="py-20 px-4" style="background: linear-gradient(135deg, #f8faff 0%, #eef2ff 50%, #f0f9ff 100%);">
    <div class="max-w-4xl mx-auto">

      <!-- Header editorial -->
      <div class="text-center mb-12">
        <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-4">Editorial</span>
        <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-3">Sobre a Equipe TeckHome</h2>
        <div class="w-16 h-1 bg-indigo-600 rounded-full mx-auto"></div>
      </div>

      <!-- Card principal da equipe -->
      <div class="bg-white rounded-3xl shadow-xl border border-indigo-50 overflow-hidden" style="box-shadow: 0 20px 60px rgba(99,102,241,0.12);">

        <!-- Top accent bar -->
        <div class="h-1.5 w-full" style="background: linear-gradient(90deg, #6366f1, #818cf8, #38bdf8, #6366f1); background-size: 200% 100%; animation: gradientMove 4s linear infinite;"></div>

        <div class="p-8 md:p-10">
          <div class="flex flex-col md:flex-row items-center md:items-start gap-8">

            <!-- Avatar / Logo identidade -->
            <div class="flex-shrink-0">
              <div class="relative">
                <div class="w-28 h-28 rounded-2xl flex items-center justify-center shadow-lg" style="background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #1e3a5f 100%);">
                  <div class="text-center">
                    <div class="text-3xl mb-1">🏠</div>
                    <div class="text-white text-xs font-bold tracking-wide">TECH</div>
                  </div>
                </div>
                <!-- Badge verificado -->
                <div class="absolute -bottom-2 -right-2 w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center shadow-md border-2 border-white">
                  <i class="fas fa-check text-white text-xs"></i>
                </div>
              </div>
            </div>

            <!-- Conteúdo editorial -->
            <div class="flex-1 text-center md:text-left">
              <div class="flex flex-col md:flex-row items-center md:items-start gap-3 mb-4">
                <div>
                  <h3 class="text-2xl font-black text-gray-900">Equipe TeckHome</h3>
                  <div class="flex items-center justify-center md:justify-start gap-2 mt-1">
                    <span class="inline-flex items-center gap-1 text-xs text-indigo-600 font-semibold bg-indigo-50 px-3 py-1 rounded-full">
                      <i class="fas fa-shield-alt text-xs"></i> Portal Verificado
                    </span>
                    <span class="inline-flex items-center gap-1 text-xs text-emerald-600 font-semibold bg-emerald-50 px-3 py-1 rounded-full">
                      <span class="w-1.5 h-1.5 bg-emerald-500 rounded-full" style="animation: pulse 2s infinite;"></span> Ativo
                    </span>
                  </div>
                </div>
              </div>

              <p class="text-gray-600 text-base leading-relaxed mb-6">
                A Equipe TeckHome reúne conteúdos, análises e recomendações de produtos voltados para tecnologia, casa e utilidades do dia a dia. Nosso objetivo é ajudar consumidores a fazer escolhas mais inteligentes através de reviews organizados, comparativos e conteúdos informativos.
              </p>

              <!-- Stats da equipe -->
              <div class="grid grid-cols-3 gap-4">
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">7</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Categorias</div>
                </div>
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">100%</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Imparcial</div>
                </div>
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">🇧🇷</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Mercado BR</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pilares editoriais -->
          <div class="mt-10 pt-8 border-t border-gray-100">
            <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-5">Nossos Pilares</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="flex items-start gap-3 p-4 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-300 transition-all">
                <div class="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-search text-indigo-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Análise Técnica</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Reviews baseados em dados e avaliações reais de mercado</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-blue-50 rounded-2xl border border-blue-100 hover:border-blue-300 transition-all">
                <div class="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-balance-scale text-blue-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Comparativos</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Comparações honestas para facilitar sua decisão de compra</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-sky-50 rounded-2xl border border-sky-100 hover:border-sky-300 transition-all">
                <div class="w-9 h-9 bg-sky-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-home text-sky-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Foco no Lar</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Especialistas em tecnologia, eletrodomésticos e utilidades</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  </section>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white pt-14 pb-6 px-4">
    <div class="max-w-7xl mx-auto">

      <!-- Grade principal do footer -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 pb-10 border-b border-gray-700">

        <!-- Coluna 1: Logo + descrição -->
        <div class="lg:col-span-1">
          <div class="flex items-center gap-3 mb-4">
            <img src="/static/logo.png" alt="TeckHome Store" class="w-12 h-12 rounded-xl object-cover shadow-lg">
            <div>
              <span class="text-xl font-black">Teck<span class="text-indigo-400">Home</span> Store</span>
              <p class="text-gray-400 text-xs mt-0.5">Descubra antes de comprar</p>
            </div>
          </div>
          <p class="text-gray-400 text-sm leading-relaxed mb-4">
            Portal de reviews, comparativos e recomendações de produtos para tecnologia, casa e utilidades do dia a dia.
          </p>
          <div class="flex flex-col gap-2 text-sm">
            <a href="https://teckhomestore.com" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
              <i class="fas fa-globe text-xs"></i> teckhomestore.com
            </a>
            <a href="mailto:contato@teckhomestore.com" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
              <i class="fas fa-envelope text-xs"></i> contato@teckhomestore.com
            </a>
          </div>
        </div>

        <!-- Coluna 2: Navegação -->
        <div>
          <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-5">Navegação</h4>
          <ul class="flex flex-col gap-3 text-sm text-gray-400">
            <li><a href="/" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-home text-xs text-indigo-400"></i> Início</a></li>
            <li><a href="#destaques" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-star text-xs text-indigo-400"></i> Destaques</a></li>
            <li><a href="#categorias" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-th-large text-xs text-indigo-400"></i> Categorias</a></li>
            <li><a href="#equipe-teckhome" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-users text-xs text-indigo-400"></i> Equipe TeckHome</a></li>
            <li><a href="/admin" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-lock text-xs text-indigo-400"></i> Painel Admin</a></li>
          </ul>
        </div>

        <!-- Coluna 3: Categorias -->
        <div>
          <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-5">Categorias</h4>
          <ul class="flex flex-col gap-3 text-sm text-gray-400">
            <li><a href="/categoria/eletronicos" class="hover:text-white transition-colors">📱 Eletrônicos</a></li>
            <li><a href="/categoria/eletrodomesticos" class="hover:text-white transition-colors">🏠 Eletrodomésticos</a></li>
            <li><a href="/categoria/ferramentas" class="hover:text-white transition-colors">🔧 Ferramentas Elétricas</a></li>
            <li><a href="/categoria/refrigeracao" class="hover:text-white transition-colors">❄️ Refrigeração</a></li>
            <li><a href="/categoria/cama-mesa" class="hover:text-white transition-colors">🛏️ Cama e Mesa</a></li>
            <li><a href="/categoria/ventilacao" class="hover:text-white transition-colors">💨 Ventilação</a></li>
            <li><a href="/categoria/jardim" class="hover:text-white transition-colors">🌱 Jardim</a></li>
          </ul>
        </div>

        <!-- Coluna 4: Informações legais + Contato -->
        <div>
          <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-5">Informações</h4>
          <ul class="flex flex-col gap-3 text-sm text-gray-400">
            <li><a href="/termos-de-uso" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-file-alt text-xs text-indigo-400"></i> Termos de Uso</a></li>
            <li><a href="/politica-de-privacidade" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-shield-alt text-xs text-indigo-400"></i> Política de Privacidade</a></li>
            <li><a href="/politica-de-cookies" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-cookie-bite text-xs text-indigo-400"></i> Política de Cookies</a></li>
            <li><a href="/sobre" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-info-circle text-xs text-indigo-400"></i> Sobre Nós</a></li>
          </ul>
          <div class="mt-6 pt-5 border-t border-gray-700">
            <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-3">Contato</h4>
            <a href="mailto:contato@teckhomestore.com" class="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-2">
              <i class="fas fa-envelope text-indigo-400 text-xs"></i> contato@teckhomestore.com
            </a>
            <a href="https://teckhomestore.com" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors">
              <i class="fas fa-globe text-indigo-400 text-xs"></i> teckhomestore.com
            </a>
          </div>
        </div>

      </div>

      <!-- Rodapé inferior: copyright + disclaimer -->
      <div class="pt-6 flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-gray-500">
        <p>© 2026 TeckHome Store. Todos os direitos reservados.</p>
        <p class="text-center max-w-xl leading-relaxed">
          Este site contém links de afiliados. Podemos receber comissão por compras realizadas através dos links, sem custo adicional para você. Os preços e disponibilidade podem variar.
        </p>
        <p>Desenvolvido por <span class="text-indigo-400 font-semibold">Equipe TeckHome</span></p>
      </div>

    </div>
  </footer>

  <script>
    let allProductsCache = []

    // Mobile menu
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('mobileMenu').classList.toggle('hidden')
    })

    // Gera análise persuasiva automática baseada no produto
    function generateAnalysis(product, category) {
      const catName = category ? category.name : 'produtos'
      const store = product.store || 'grande loja'
      const title = product.title || 'produto'
      const analyses = [
        \`Se você está buscando qualidade comprovada em \${catName}, este produto se destaca entre os mais recomendados do mercado. Com avaliações positivas de consumidores reais e disponível na \${store}, ele entrega exatamente o que promete — sem surpresas desagradáveis na hora do uso.\`,
        \`Depois de analisar as principais opções disponíveis em \${catName}, este produto chama atenção pelo custo-benefício acima da média. É o tipo de escolha que você não se arrepende: robusto, funcional e bem avaliado por quem já comprou.\`,
        \`Quer fazer uma compra inteligente em \${catName}? Este é um dos produtos que nossa equipe recomenda com confiança. A combinação de qualidade, durabilidade e boa reputação o coloca entre os favoritos de quem entende do assunto.\`,
        \`Não perca tempo com produtos mediocres. Este item se destaca em \${catName} pela consistência nas avaliações e pela confiança que a \${store} oferece. É a escolha de quem quer acertar na compra sem precisar testar várias opções.\`,
        \`Para quem busca o melhor em \${catName} sem abrir mão da qualidade, este produto é uma das opções mais bem avaliadas disponíveis hoje. Nossa análise confirma o que os consumidores já dizem: vale cada centavo investido.\`
      ]
      const idx = (product.title.length + (category ? category.id.length : 0)) % analyses.length
      return analyses[idx]
    }

    function createProductCard(product, category) {
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1 shadow-lg"><i class="fas fa-star text-xs"></i> Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=400\`
      const storeName = product.store || 'Loja Parceira'
      const analysis = generateAnalysis(product, category)
      const catIcon = category ? category.icon : '🛒'

      return \`
        <article class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col" itemscope itemtype="https://schema.org/Product">
          <!-- Imagem -->
          <div class="relative overflow-hidden">
            <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer sponsored" aria-label="Ver \${product.title} na \${storeName}">
              <div class="h-52 overflow-hidden bg-gray-50">
                <img src="\${imgSrc}" alt="\${product.title} — Review TeckHome Store" class="w-full h-full object-cover hover:scale-110 transition-transform duration-500" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=400'" itemprop="image">
              </div>
            </a>
            \${featuredBadge}
            <div class="absolute top-3 right-3 bg-white/90 backdrop-blur-sm text-xl w-9 h-9 rounded-xl flex items-center justify-center shadow-sm">\${catIcon}</div>
            <!-- Loja badge -->
            <div class="absolute bottom-3 left-3">
              <span class="bg-white/95 backdrop-blur-sm text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-lg shadow-sm border border-indigo-100">\${storeName}</span>
            </div>
          </div>

          <!-- Conteúdo -->
          <div class="p-5 flex flex-col flex-1 gap-3">
            <!-- Título -->
            <h3 class="font-black text-gray-900 text-sm leading-snug line-clamp-2" itemprop="name">\${product.title}</h3>

            <!-- Análise persuasiva gerada automaticamente -->
            <div class="bg-gradient-to-br from-indigo-50 to-blue-50 rounded-xl p-3 border border-indigo-100">
              <div class="flex items-center gap-1.5 mb-1.5">
                <i class="fas fa-clipboard-check text-indigo-500 text-xs"></i>
                <span class="text-xs font-bold text-indigo-700 uppercase tracking-wide">Análise TeckHome</span>
              </div>
              <p class="text-gray-700 text-xs leading-relaxed line-clamp-4">\${analysis}</p>
            </div>

            <!-- Trust signals -->
            <div class="flex items-center gap-2 flex-wrap">
              <span class="trust-badge text-xs font-semibold text-green-700 px-2.5 py-1 rounded-lg flex items-center gap-1">
                <i class="fas fa-shield-alt text-xs"></i> Verificado
              </span>
              <span class="bg-amber-50 border border-amber-200 text-xs font-semibold text-amber-700 px-2.5 py-1 rounded-lg flex items-center gap-1">
                <i class="fas fa-star text-xs"></i> Recomendado
              </span>
            </div>

            <!-- Botão Ver Preço -->
            <div class="mt-auto pt-2">
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer sponsored"
                class="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-sm font-bold px-4 py-3 rounded-xl transition-all shadow-md hover:shadow-indigo-200 hover:shadow-lg">
                <i class="fas fa-tag text-xs"></i>
                Ver Preço na \${storeName}
                <i class="fas fa-arrow-right text-xs ml-auto"></i>
              </a>
            </div>
          </div>

          <!-- Editorial footer -->
          <div class="editorial-footer px-4 py-3 flex items-center gap-2 rounded-b-2xl">
            <div class="w-5 h-5 rounded-md flex-shrink-0 flex items-center justify-center text-xs" style="background: linear-gradient(135deg, #1e1b4b, #3730a3);">🏠</div>
            <div class="min-w-0 flex items-center gap-1">
              <span class="text-xs font-bold text-indigo-700">Por Equipe TeckHome</span>
              <span class="text-gray-300 text-xs">·</span>
              <span class="text-xs text-gray-400">Análise independente</span>
            </div>
          </div>
        </article>
      \`
    }

    async function loadCategories() {
      const res = await fetch('/api/categories')
      const categories = await res.json()
      
      const grid = document.getElementById('categoriesGrid')
      grid.innerHTML = categories.map(cat => \`
        <a href="/categoria/\${cat.id}" class="category-card card-hover bg-white rounded-2xl p-6 shadow-md border border-gray-100 flex flex-col items-start gap-3 cursor-pointer group">
          <div class="w-12 h-12 rounded-xl flex items-center justify-center text-2xl" style="background: \${cat.color}20">
            <span class="category-icon">\${cat.icon}</span>
          </div>
          <div>
            <h3 class="font-bold text-gray-800 group-hover:text-indigo-600 transition-colors">\${cat.name}</h3>
            <p class="text-gray-400 text-xs mt-0.5 line-clamp-2">\${cat.description}</p>
          </div>
          <div class="flex items-center gap-1 text-indigo-600 text-xs font-medium mt-auto">
            Ver produtos <i class="fas fa-arrow-right text-xs"></i>
          </div>
        </a>
      \`).join('')

      return categories
    }

    async function loadFeatured(categories) {
      const res = await fetch('/api/products')
      allProductsCache = await res.json()
      const featured = allProductsCache.filter(p => p.featured).slice(0, 8)
      
      const grid = document.getElementById('featuredGrid')
      const noFeatured = document.getElementById('noFeatured')
      
      if (featured.length === 0) {
        grid.innerHTML = ''
        noFeatured.classList.remove('hidden')
        return
      }
      
      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)
      grid.innerHTML = featured.map(p => createProductCard(p, catMap[p.categoryId])).join('')
    }

    function handleSearch(query) {
      const searchResults = document.getElementById('searchResults')
      const heroSection = document.getElementById('categorias')
      
      if (!query.trim()) {
        searchResults.classList.add('hidden')
        return
      }
      
      const q = query.toLowerCase()
      const filtered = allProductsCache.filter(p => 
        p.title.toLowerCase().includes(q) || 
        p.description.toLowerCase().includes(q) ||
        (p.store && p.store.toLowerCase().includes(q))
      )
      
      searchResults.classList.remove('hidden')
      
      const grid = document.getElementById('searchGrid')
      const noResults = document.getElementById('noResults')
      
      if (filtered.length === 0) {
        grid.innerHTML = ''
        noResults.classList.remove('hidden')
      } else {
        noResults.classList.add('hidden')
        grid.innerHTML = filtered.slice(0, 12).map(p => createProductCard(p, null)).join('')
      }
    }

    // Artigos do blog (estáticos + dinâmicos via admin)
    const staticArticles = [
      {
        id: 'guia-eletronicos',
        title: 'Como escolher o melhor smartphone em 2026: tudo que você precisa saber antes de comprar',
        excerpt: 'Você está prestes a gastar centenas de reais em um celular — e pode cometer o mesmo erro que milhares de brasileiros cometem todo ano: comprar pelo nome da marca, e não pelo que o produto realmente entrega. Neste guia, revelamos os 5 critérios que profissionais de tecnologia usam para avaliar smartphones, e que vão mudar completamente a forma como você escolhe o próximo aparelho. Processador, câmera, bateria, custo-benefício e suporte pós-venda: cada detalhe analisado para você comprar com absoluta segurança.',
        category: 'Eletrônicos',
        categoryIcon: '📱',
        image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=600&q=80',
        readTime: '6 min',
        keywords: 'melhor smartphone 2026, como escolher celular, review celular custo-benefício, smartphone barato bom'
      },
      {
        id: 'guia-eletrodomesticos',
        title: 'Air fryer ou forno elétrico? A verdade que as marcas não te contam — e qual comprar em 2026',
        excerpt: 'A air fryer se tornou febre no Brasil — mas será que ela é realmente superior ao forno elétrico, ou é apenas marketing bem feito? Nossa equipe testou os dois aparelhos durante semanas em situações reais de uso: preparo diário, consumo de energia, limpeza, versatilidade e durabilidade. O resultado surpreendeu até nós. Antes de tomar qualquer decisão de compra, leia nossa análise completa e descubra qual opção realmente faz mais sentido para o seu estilo de vida, seu orçamento e o tamanho da sua cozinha.',
        category: 'Eletrodomésticos',
        categoryIcon: '🏠',
        image: 'https://images.unsplash.com/photo-1585515320310-259814833e62?w=600&q=80',
        readTime: '7 min',
        keywords: 'air fryer vs forno elétrico, melhor air fryer 2026, qual comprar, air fryer consume energia'
      },
      {
        id: 'guia-refrigeracao',
        title: 'Ar-condicionado em 2026: split, portátil ou janela? O guia definitivo para escolher sem erro',
        excerpt: 'Comprar o ar-condicionado errado pode te custar mais de R$ 500 extras por ano só na conta de luz — sem contar os gastos com instalação e manutenção. A pergunta que todo mundo faz é: split ou portátil? Mas essa é só a ponta do iceberg. Neste guia completo, explicamos como calcular o BTU ideal para cada cômodo, qual modelo consome menos energia, quando o portátil compensa, e os 3 erros mais comuns que as pessoas cometem na hora de comprar. Não gaste um centavo antes de ler.',
        category: 'Refrigeração',
        categoryIcon: '❄️',
        image: 'https://images.unsplash.com/photo-1631545806609-88e3f14ff966?w=600&q=80',
        readTime: '8 min',
        keywords: 'ar condicionado split vs portátil, melhor ar condicionado 2026, BTU ideal, ar condicionado econômico'
      },
      {
        id: 'guia-ferramentas',
        title: 'As 7 ferramentas elétricas que todo proprietário de imóvel precisa ter em casa',
        excerpt: 'Se você é proprietário de imóvel ou simplesmente gosta de resolver problemas em casa sem depender de terceiros, existem 7 ferramentas elétricas que vão transformar sua vida — e pagar o próprio custo em menos de 6 meses. Nossa equipe analisou dezenas de modelos disponíveis no mercado brasileiro e selecionou os que reúnem melhor custo-benefício, durabilidade e facilidade de uso para quem não é profissional. Do parafusadeira à esmerilhadeira, descubra o que realmente vale a pena comprar em 2026.',
        category: 'Ferramentas',
        categoryIcon: '🔧',
        image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=600&q=80',
        readTime: '6 min',
        keywords: 'ferramentas elétricas essenciais, melhor parafusadeira 2026, kit ferramentas casa, ferramentas custo-benefício'
      }
    ]

    async function loadBlog() {
      // Busca artigos do admin
      let adminArticles = []
      try {
        const res = await fetch('/api/articles')
        if (res.ok) adminArticles = await res.json()
      } catch(e) {}

      const allArticles = [...adminArticles, ...staticArticles].slice(0, 6)
      const grid = document.getElementById('blogGrid')
      const noBlog = document.getElementById('noBlog')

      if (allArticles.length === 0) {
        grid.innerHTML = ''
        noBlog.classList.remove('hidden')
        return
      }

      grid.innerHTML = allArticles.map(art => \`
        <article class="blog-card bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col" itemscope itemtype="https://schema.org/Article">
          <div class="relative h-48 overflow-hidden bg-gray-100">
            <img src="\${art.image || 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80'}"
              alt="\${art.title}"
              class="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
              onerror="this.src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80'"
              itemprop="image">
            <div class="absolute top-3 left-3">
              <span class="bg-indigo-600 text-white text-xs font-bold px-2.5 py-1 rounded-lg shadow">\${art.categoryIcon || '📝'} \${art.category || 'Geral'}</span>
            </div>
            <div class="absolute top-3 right-3">
              <span class="bg-black/50 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-lg"><i class="fas fa-clock text-xs mr-1"></i>\${art.readTime || '4 min'}</span>
            </div>
          </div>
          <div class="p-5 flex flex-col flex-1 gap-3">
            <h3 class="font-black text-gray-900 text-base leading-snug line-clamp-2 hover:text-indigo-600 transition-colors" itemprop="headline">\${art.title}</h3>
            <p class="text-gray-500 text-sm leading-relaxed line-clamp-3" itemprop="description">\${art.excerpt}</p>
            <div class="mt-auto pt-3 border-t border-gray-100 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-md flex items-center justify-center text-xs" style="background: linear-gradient(135deg, #1e1b4b, #3730a3);">🏠</div>
                <span class="text-xs text-gray-500 font-medium">Equipe TeckHome</span>
              </div>
              <a href="\${art.url || '#blog'}" class="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                Ler artigo <i class="fas fa-arrow-right text-xs"></i>
              </a>
            </div>
          </div>
        </article>
      \`).join('')
    }

    async function init() {
      const categories = await loadCategories()
      await loadFeatured(categories)
      await loadBlog()
    }

    init()
  </script>
</body>
</html>`
}

function categoryPage(categoryId: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeckHome Store - Categoria</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .card-hover { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card-hover:hover { transform: translateY(-8px); box-shadow: 0 25px 50px rgba(0,0,0,0.15); }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 4px; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Descubra antes de comprar</span>
          </div>
        </a>
        <div class="flex items-center gap-4">
          <a href="/" class="text-sm font-medium text-gray-600 hover:text-indigo-600 transition-colors flex items-center gap-1">
            <i class="fas fa-home text-xs"></i> Início
          </a>
          <a href="/admin" class="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-indigo-700 transition-colors flex items-center gap-2">
            <i class="fas fa-plus text-xs"></i> Adicionar
          </a>
        </div>
      </div>
    </div>
  </nav>

  <!-- HEADER DA CATEGORIA -->
  <div id="categoryHeader" class="py-12 px-4">
    <div class="max-w-7xl mx-auto">
      <div class="shimmer h-8 w-48 rounded-xl mb-2"></div>
      <div class="shimmer h-5 w-80 rounded-xl"></div>
    </div>
  </div>

  <!-- FILTROS -->
  <div class="max-w-7xl mx-auto px-4 mb-6">
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-wrap items-center gap-3">
      <span class="text-sm font-semibold text-gray-700 mr-2">Filtrar:</span>
      <button onclick="filterProducts('all')" id="filter-all" class="filter-btn active-filter text-xs font-medium px-3 py-1.5 rounded-xl border border-indigo-600 bg-indigo-600 text-white transition-all">
        Todos
      </button>
      <button onclick="filterProducts('featured')" id="filter-featured" class="filter-btn text-xs font-medium px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition-all">
        ⭐ Destaques
      </button>
      <div class="ml-auto">
        <input id="catSearch" type="text" placeholder="Buscar nesta categoria..." 
          class="text-sm px-4 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 w-52"
          oninput="filterBySearch(this.value)">
      </div>
    </div>
  </div>

  <!-- GRID DE PRODUTOS -->
  <main class="max-w-7xl mx-auto px-4 pb-16">
    <div id="productsGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="emptyState" class="hidden text-center py-20">
      <div class="text-7xl mb-6 opacity-30" id="emptyIcon">📦</div>
      <h3 class="text-xl font-bold text-gray-600 mb-2">Nenhum produto nesta categoria ainda</h3>
      <p class="text-gray-400 mb-6">Seja o primeiro a adicionar um produto!</p>
      <a href="/admin" class="bg-indigo-600 text-white font-semibold px-6 py-3 rounded-xl hover:bg-indigo-700 transition-colors inline-flex items-center gap-2">
        <i class="fas fa-plus"></i> Adicionar Produto
      </a>
    </div>
  </main>

  <!-- BLOG -->
  <section id="blog" class="max-w-7xl mx-auto px-4 py-16">
    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-12">
      <div>
        <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Blog TeckHome</span>
        <h2 class="text-3xl font-black text-gray-900 mb-2">Artigos e Guias de Compra</h2>
        <p class="text-gray-500 max-w-xl">Conteúdo especializado para ajudar você a fazer a melhor escolha antes de comprar.</p>
      </div>
    </div>
    <div id="blogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="noBlog" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-newspaper text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium mb-2">Nenhum artigo publicado ainda</p>
      <a href="/admin" class="text-indigo-600 font-medium hover:underline">Criar primeiro artigo →</a>
    </div>
  </section>

  <!-- EQUIPE TECKHOME -->
  <section id="equipe-teckhome" class="py-20 px-4" style="background: linear-gradient(135deg, #f8faff 0%, #eef2ff 50%, #f0f9ff 100%);">
    <div class="max-w-4xl mx-auto">

      <!-- Header editorial -->
      <div class="text-center mb-12">
        <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-4">Editorial</span>
        <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-3">Sobre a Equipe TeckHome</h2>
        <div class="w-16 h-1 bg-indigo-600 rounded-full mx-auto"></div>
      </div>

      <!-- Card principal da equipe -->
      <div class="bg-white rounded-3xl shadow-xl border border-indigo-50 overflow-hidden" style="box-shadow: 0 20px 60px rgba(99,102,241,0.12);">

        <!-- Top accent bar -->
        <div class="h-1.5 w-full" style="background: linear-gradient(90deg, #6366f1, #818cf8, #38bdf8, #6366f1); background-size: 200% 100%; animation: gradientMove 4s linear infinite;"></div>

        <div class="p-8 md:p-10">
          <div class="flex flex-col md:flex-row items-center md:items-start gap-8">

            <!-- Avatar / Logo identidade -->
            <div class="flex-shrink-0">
              <div class="relative">
                <div class="w-28 h-28 rounded-2xl flex items-center justify-center shadow-lg" style="background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #1e3a5f 100%);">
                  <div class="text-center">
                    <div class="text-3xl mb-1">🏠</div>
                    <div class="text-white text-xs font-bold tracking-wide">TECH</div>
                  </div>
                </div>
                <!-- Badge verificado -->
                <div class="absolute -bottom-2 -right-2 w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center shadow-md border-2 border-white">
                  <i class="fas fa-check text-white text-xs"></i>
                </div>
              </div>
            </div>

            <!-- Conteúdo editorial -->
            <div class="flex-1 text-center md:text-left">
              <div class="flex flex-col md:flex-row items-center md:items-start gap-3 mb-4">
                <div>
                  <h3 class="text-2xl font-black text-gray-900">Equipe TeckHome</h3>
                  <div class="flex items-center justify-center md:justify-start gap-2 mt-1">
                    <span class="inline-flex items-center gap-1 text-xs text-indigo-600 font-semibold bg-indigo-50 px-3 py-1 rounded-full">
                      <i class="fas fa-shield-alt text-xs"></i> Portal Verificado
                    </span>
                    <span class="inline-flex items-center gap-1 text-xs text-emerald-600 font-semibold bg-emerald-50 px-3 py-1 rounded-full">
                      <span class="w-1.5 h-1.5 bg-emerald-500 rounded-full" style="animation: pulse 2s infinite;"></span> Ativo
                    </span>
                  </div>
                </div>
              </div>

              <p class="text-gray-600 text-base leading-relaxed mb-6">
                A Equipe TeckHome reúne conteúdos, análises e recomendações de produtos voltados para tecnologia, casa e utilidades do dia a dia. Nosso objetivo é ajudar consumidores a fazer escolhas mais inteligentes através de reviews organizados, comparativos e conteúdos informativos.
              </p>

              <!-- Stats da equipe -->
              <div class="grid grid-cols-3 gap-4">
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">7</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Categorias</div>
                </div>
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">100%</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Imparcial</div>
                </div>
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">🇧🇷</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Mercado BR</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pilares editoriais -->
          <div class="mt-10 pt-8 border-t border-gray-100">
            <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-5">Nossos Pilares</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="flex items-start gap-3 p-4 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-300 transition-all">
                <div class="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-search text-indigo-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Análise Técnica</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Reviews baseados em dados e avaliações reais de mercado</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-blue-50 rounded-2xl border border-blue-100 hover:border-blue-300 transition-all">
                <div class="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-balance-scale text-blue-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Comparativos</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Comparações honestas para facilitar sua decisão de compra</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-sky-50 rounded-2xl border border-sky-100 hover:border-sky-300 transition-all">
                <div class="w-9 h-9 bg-sky-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-home text-sky-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Foco no Lar</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Especialistas em tecnologia, eletrodomésticos e utilidades</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  </section>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white py-8 px-4 mt-8">
    <div class="max-w-7xl mx-auto flex justify-between items-center flex-wrap gap-4">
      <span class="font-black text-lg">Teck<span class="text-indigo-400">Home</span> Store</span>
      <p class="text-gray-500 text-sm">© 2026 TeckHome Store</p>
    </div>
  </footer>

  <script>
    const CATEGORY_ID = '${categoryId}'
    let allProducts = []
    let category = null
    let currentFilter = 'all'
    let currentSearch = ''

    function createProductCard(product) {
      const stars = product.rating ? '★'.repeat(Math.round(product.rating)) + '☆'.repeat(5 - Math.round(product.rating)) : ''
      const storeIcon = product.store ? \`<span class="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium">\${product.store}</span>\` : ''
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1"><i class="fas fa-star text-xs"></i> Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200\`
      
      return \`
        <div class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col" data-id="\${product.id}">
          <div class="relative">
            <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer">
              <div class="h-52 overflow-hidden bg-gray-50">
                <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-full object-cover hover:scale-105 transition-transform duration-300" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200'">
              </div>
            </a>
            \${featuredBadge}
          </div>
          <div class="p-4 flex flex-col flex-1 gap-2">
            <h3 class="font-bold text-gray-800 text-sm leading-tight line-clamp-2">\${product.title}</h3>
            \${product.description ? \`<p class="text-gray-500 text-xs line-clamp-2">\${product.description}</p>\` : ''}
            <div class="flex items-center gap-2">
              \${storeIcon}
              \${stars ? \`<span class="text-yellow-400 text-xs">\${stars}</span>\` : ''}
            </div>
            <div class="flex items-center justify-between gap-2 mt-auto pt-2">
              \${product.price ? \`<span class="text-lg font-black text-indigo-700">\${product.price}</span>\` : '<span class="text-sm text-gray-400">Ver preço</span>'}
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer" 
                class="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors">
                Comprar <i class="fas fa-external-link-alt text-xs"></i>
              </a>
            </div>
          </div>
        </div>
      \`
    }

    function renderProducts() {
      let filtered = [...allProducts]
      
      if (currentFilter === 'featured') {
        filtered = filtered.filter(p => p.featured)
      }
      
      if (currentSearch) {
        const q = currentSearch.toLowerCase()
        filtered = filtered.filter(p => 
          p.title.toLowerCase().includes(q) || 
          (p.description && p.description.toLowerCase().includes(q))
        )
      }
      
      const grid = document.getElementById('productsGrid')
      const emptyState = document.getElementById('emptyState')
      
      if (filtered.length === 0) {
        grid.innerHTML = ''
        emptyState.classList.remove('hidden')
        if (category) document.getElementById('emptyIcon').textContent = category.icon
      } else {
        emptyState.classList.add('hidden')
        grid.innerHTML = filtered.map(createProductCard).join('')
      }
    }

    function filterProducts(filter) {
      currentFilter = filter
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active-filter', 'border-indigo-600', 'bg-indigo-600', 'text-white')
        btn.classList.add('border-gray-200', 'text-gray-600')
      })
      const btn = document.getElementById(\`filter-\${filter}\`)
      btn.classList.add('active-filter', 'border-indigo-600', 'bg-indigo-600', 'text-white')
      btn.classList.remove('border-gray-200', 'text-gray-600')
      renderProducts()
    }

    function filterBySearch(value) {
      currentSearch = value
      renderProducts()
    }

    async function init() {
      // Carregar categoria
      const catRes = await fetch('/api/categories')
      const categories = await catRes.json()
      category = categories.find(c => c.id === CATEGORY_ID)
      
      if (category) {
        document.title = \`TeckHome Store - \${category.name}\`
        document.getElementById('categoryHeader').innerHTML = \`
          <div class="max-w-7xl mx-auto">
            <nav class="text-sm text-gray-400 mb-3 flex items-center gap-2">
              <a href="/" class="hover:text-indigo-600 transition-colors">Início</a>
              <i class="fas fa-chevron-right text-xs"></i>
              <span class="text-gray-600 font-medium">\${category.name}</span>
            </nav>
            <div class="flex items-center gap-4">
              <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl" style="background: \${category.color}20">
                \${category.icon}
              </div>
              <div>
                <h1 class="text-3xl font-black text-gray-900">\${category.name}</h1>
                <p class="text-gray-500">\${category.description}</p>
              </div>
            </div>
          </div>
        \`
      }

      // Carregar produtos
      const prodRes = await fetch(\`/api/products/\${CATEGORY_ID}\`)
      allProducts = await prodRes.json()
      renderProducts()
    }

    init()
  </script>
</body>
</html>`
}

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeckHome Store - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .toast { position: fixed; bottom: 24px; right: 24px; z-index: 9999; transform: translateX(200%); transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
    .toast.show { transform: translateX(0); }
    .card-admin { transition: all 0.2s ease; }
    .card-admin:hover { box-shadow: 0 8px 25px rgba(0,0,0,0.1); }
    .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #6366f1; border-radius: 50%; width: 24px; height: 24px; animation: spin 0.8s linear infinite; display: inline-block; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- Toast -->
  <div id="toast" class="toast">
    <div id="toastInner" class="bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72">
      <i id="toastIcon" class="text-xl"></i>
      <span id="toastMsg" class="font-medium text-gray-800 text-sm"></span>
    </div>
  </div>

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Painel Admin</span>
          </div>
        </a>
        <div class="flex items-center gap-3">
          <a href="/" class="text-sm font-medium text-gray-600 hover:text-indigo-600 flex items-center gap-1">
            <i class="fas fa-eye text-xs"></i> Ver Site
          </a>
          <a href="/admin/logout" class="flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 text-sm font-semibold px-4 py-2 rounded-xl transition-colors border border-red-200">
            <i class="fas fa-sign-out-alt text-xs"></i> Sair
          </a>
        </div>
      </div>
    </div>
  </nav>

  <!-- TABS NAV -->
  <div class="max-w-7xl mx-auto px-4 pt-6 pb-0">
    <div class="flex gap-2 border-b border-gray-200">
      <button onclick="switchTab('produtos')" id="tab-produtos"
        class="tab-btn px-5 py-3 text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-box text-xs"></i> Produtos
      </button>
      <button onclick="switchTab('blog')" id="tab-blog"
        class="tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-indigo-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-newspaper text-xs"></i> Blog / Artigos
      </button>
    </div>
  </div>

  <!-- TAB: PRODUTOS -->
  <div id="section-produtos" class="max-w-7xl mx-auto px-4 py-8">
    <div class="grid lg:grid-cols-5 gap-8">
      
      <!-- FORMULÁRIO DE ADICIONAR -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-plus-circle text-indigo-600"></i> Adicionar Produto
          </h2>
          <p class="text-gray-400 text-sm mb-6">Cole o link do produto para buscar automaticamente</p>

          <!-- URL Input com auto-fetch -->
          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-2">
              Link do Produto <span class="text-red-500">*</span>
            </label>
            <div class="flex gap-2">
              <input type="url" id="productUrl" placeholder="https://www.amazon.com.br/..." 
                class="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
                onpaste="setTimeout(() => fetchMetadata(), 100)">
              <button onclick="fetchMetadata()" id="fetchBtn"
                class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 whitespace-nowrap">
                <i class="fas fa-magic"></i> Buscar
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">Cole o link e clique em "Buscar" para preencher automaticamente</p>
          </div>

          <!-- Preview da URL -->
          <div id="urlPreview" class="hidden mb-4 p-3 bg-indigo-50 rounded-xl border border-indigo-100 flex items-center gap-3">
            <img id="previewImg" src="" alt="" class="w-14 h-14 object-cover rounded-lg border border-indigo-200 bg-white">
            <div class="flex-1 min-w-0">
              <p id="previewTitle" class="text-sm font-bold text-gray-800 line-clamp-2"></p>
              <p id="previewStore" class="text-xs text-indigo-600 mt-0.5 font-medium"></p>
            </div>
          </div>

          <!-- Campos do formulário -->
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Categoria <span class="text-red-500">*</span></label>
              <select id="categoryId" class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white transition-all">
                <option value="">Selecione uma categoria...</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Título do Produto <span class="text-red-500">*</span></label>
              <input type="text" id="productTitle" placeholder="Ex: Smart TV Samsung 55' 4K" 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">
                Descrição do Vendedor
                <span class="text-xs text-gray-400 font-normal ml-1">(só para coleta — não exibida)</span>
              </label>
              <textarea id="productDesc" rows="2" placeholder="Cole a descrição original do produto aqui para referência..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none transition-all bg-amber-50 border-amber-200"></textarea>
              <p class="text-xs text-amber-600 mt-1 flex items-center gap-1"><i class="fas fa-info-circle"></i> Esta descrição é apenas para referência interna. O site exibirá uma análise persuasiva gerada automaticamente.</p>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Loja <span class="text-red-500">*</span></label>
                <input type="text" id="productStore" placeholder="Amazon, Mercado Livre..." 
                  class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Avaliação (0-5)</label>
                <div class="flex items-center gap-2 mt-3">
                  <input type="range" id="productRating" min="0" max="5" step="0.5" value="0" 
                    class="flex-1 accent-indigo-600"
                    oninput="document.getElementById('ratingValue').textContent = this.value + '★'">
                  <span id="ratingValue" class="text-yellow-500 font-bold text-sm w-10 text-right">0★</span>
                </div>
              </div>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">URL da Imagem (opcional)</label>
              <input type="url" id="productImage" placeholder="https://..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div class="flex items-center gap-3 p-3 bg-yellow-50 rounded-xl border border-yellow-100">
              <input type="checkbox" id="productFeatured" class="w-4 h-4 accent-indigo-600">
              <div>
                <label for="productFeatured" class="text-sm font-semibold text-gray-700 cursor-pointer">
                  ⭐ Marcar como Destaque
                </label>
                <p class="text-xs text-gray-400">Aparece na seção de destaques da página inicial</p>
              </div>
            </div>
          </div>

          <button onclick="addProduct()" id="addBtn"
            class="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm">
            <i class="fas fa-plus"></i> Adicionar Produto
          </button>
        </div>
      </div>

      <!-- LISTA DE PRODUTOS -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-black text-gray-900 flex items-center gap-2">
            <i class="fas fa-list text-indigo-600"></i> Produtos Cadastrados
          </h2>
          <select id="filterCategory" onchange="loadProducts()" class="text-sm px-3 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 bg-white">
            <option value="">Todas as categorias</option>
          </select>
        </div>

        <div id="productsList" class="space-y-3">
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
        </div>

        <div id="emptyAdmin" class="hidden text-center py-16 text-gray-400">
          <i class="fas fa-box-open text-5xl mb-4 opacity-30"></i>
          <p class="text-lg font-medium">Nenhum produto cadastrado ainda</p>
          <p class="text-sm mt-1">Use o formulário ao lado para adicionar produtos</p>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: BLOG -->
  <div id="section-blog" class="hidden max-w-7xl mx-auto px-4 py-8">
    <div class="grid lg:grid-cols-5 gap-8">

      <!-- FORMULÁRIO DE CRIAR ARTIGO -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-pen-nib text-indigo-600"></i> Criar Artigo do Blog
          </h2>
          <p class="text-gray-400 text-sm mb-5">Cole o link de um produto e gere automaticamente um artigo persuasivo para o blog</p>

          <!-- Passo 1: URL do produto -->
          <div class="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 mb-5">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-6 h-6 bg-indigo-600 text-white text-xs font-black rounded-full flex items-center justify-center">1</span>
              <span class="text-sm font-bold text-gray-800">Cole o link do produto</span>
            </div>
            <div class="flex gap-2">
              <input type="url" id="articleProductUrl" placeholder="https://www.amazon.com.br/..." 
                class="flex-1 px-3 py-2.5 rounded-xl border border-indigo-200 text-sm outline-none focus:border-indigo-400 bg-white transition-all"
                onpaste="setTimeout(() => fetchArticleMetadata(), 100)">
              <button onclick="fetchArticleMetadata()" id="fetchArticleBtn"
                class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap">
                <i class="fas fa-magic text-xs"></i> Buscar
              </button>
            </div>
          </div>

          <!-- Preview do produto buscado -->
          <div id="articlePreview" class="hidden mb-4 p-3 bg-green-50 rounded-xl border border-green-200 flex items-center gap-3">
            <img id="articlePreviewImg" src="" alt="" class="w-14 h-14 object-cover rounded-lg bg-white flex-shrink-0">
            <div class="flex-1 min-w-0">
              <p id="articlePreviewTitle" class="text-sm font-bold text-gray-800 line-clamp-2"></p>
              <p id="articlePreviewStore" class="text-xs text-green-600 mt-0.5 font-medium"></p>
            </div>
          </div>

          <!-- Passo 2: Gerar artigo -->
          <div class="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-5">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-6 h-6 bg-purple-600 text-white text-xs font-black rounded-full flex items-center justify-center">2</span>
              <span class="text-sm font-bold text-gray-800">Gere o artigo automaticamente</span>
            </div>
            <button onclick="generateArticle()" id="generateBtn"
              class="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 text-sm shadow-md hover:shadow-lg">
              <i class="fas fa-robot text-xs"></i> Gerar Artigo Persuasivo
            </button>
            <p class="text-xs text-purple-500 mt-2 text-center">Usa técnicas de copywriting para maximizar conversões</p>
          </div>

          <!-- Campos editáveis do artigo -->
          <div id="articleFields" class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Título do Artigo <span class="text-red-500">*</span></label>
              <input type="text" id="articleTitle" placeholder="Título será gerado automaticamente..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Resumo / Excerpt <span class="text-red-500">*</span></label>
              <textarea id="articleExcerpt" rows="4" placeholder="Resumo persuasivo do artigo..."
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none transition-all"></textarea>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Categoria</label>
                <select id="articleCategory" class="w-full px-3 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                  <option value="Eletrônicos" data-icon="📱">📱 Eletrônicos</option>
                  <option value="Eletrodomésticos" data-icon="🏠">🏠 Eletrodomésticos</option>
                  <option value="Ferramentas" data-icon="🔧">🔧 Ferramentas</option>
                  <option value="Refrigeração" data-icon="❄️">❄️ Refrigeração</option>
                  <option value="Cama e Mesa" data-icon="🛏️">🛏️ Cama e Mesa</option>
                  <option value="Ventilação" data-icon="💨">💨 Ventilação</option>
                  <option value="Jardim" data-icon="🌱">🌱 Jardim</option>
                  <option value="Geral" data-icon="📝">📝 Geral</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Tempo de leitura</label>
                <select id="articleReadTime" class="w-full px-3 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                  <option>4 min</option>
                  <option>5 min</option>
                  <option selected>6 min</option>
                  <option>7 min</option>
                  <option>8 min</option>
                  <option>10 min</option>
                </select>
              </div>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Palavras-chave SEO</label>
              <input type="text" id="articleKeywords" placeholder="palavra-chave 1, palavra-chave 2..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Imagem do artigo (URL)</label>
              <input type="url" id="articleImage" placeholder="https://images.unsplash.com/..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>
          </div>

          <button onclick="publishArticle()" id="publishBtn"
            class="w-full mt-5 bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm">
            <i class="fas fa-paper-plane"></i> Publicar Artigo no Blog
          </button>
        </div>
      </div>

      <!-- LISTA DE ARTIGOS -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-black text-gray-900 flex items-center gap-2">
            <i class="fas fa-newspaper text-indigo-600"></i> Artigos Publicados
          </h2>
          <button onclick="loadArticles()" class="text-sm text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1">
            <i class="fas fa-sync text-xs"></i> Atualizar
          </button>
        </div>

        <!-- Artigos estáticos info -->
        <div class="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-4 text-sm text-blue-700 flex items-start gap-3">
          <i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
          <div>
            <strong>Artigos automáticos:</strong> O site já exibe 4 artigos editoriais fixos sobre eletrônicos, eletrodomésticos, refrigeração e ferramentas. Abaixo estão os artigos extras criados neste painel.
          </div>
        </div>

        <div id="articlesList" class="space-y-3">
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
        </div>

        <div id="emptyArticles" class="hidden text-center py-16 text-gray-400">
          <i class="fas fa-newspaper text-5xl mb-4 opacity-30"></i>
          <p class="text-lg font-medium">Nenhum artigo criado ainda</p>
          <p class="text-sm mt-1">Use o formulário ao lado para criar artigos a partir de produtos</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    let categories = []
    let allProducts = []
    let allArticles = []

    // ======= TABS =======
    function switchTab(tab) {
      document.getElementById('section-produtos').classList.toggle('hidden', tab !== 'produtos')
      document.getElementById('section-blog').classList.toggle('hidden', tab !== 'blog')
      document.getElementById('tab-produtos').className = tab === 'produtos'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-indigo-600 -mb-px transition-all flex items-center gap-2'
      document.getElementById('tab-blog').className = tab === 'blog'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-indigo-600 -mb-px transition-all flex items-center gap-2'
      if (tab === 'blog') loadArticles()
    }

    // ======= TOAST =======
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast')
      const icon = document.getElementById('toastIcon')
      const msg = document.getElementById('toastMsg')
      const inner = document.getElementById('toastInner')
      icon.className = type === 'success' ? 'fas fa-check-circle text-green-500 text-xl' :
                       type === 'error'   ? 'fas fa-times-circle text-red-500 text-xl'   :
                       'fas fa-info-circle text-blue-500 text-xl'
      inner.className = \`bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72 \${type === 'success' ? 'border-green-100' : type === 'error' ? 'border-red-100' : 'border-blue-100'}\`
      msg.textContent = message
      toast.classList.add('show')
      setTimeout(() => toast.classList.remove('show'), 3500)
    }

    // ======= PRODUTOS =======
    async function fetchMetadata() {
      const url = document.getElementById('productUrl').value.trim()
      if (!url) return
      const btn = document.getElementById('fetchBtn')
      btn.innerHTML = '<span class="spinner"></span>'
      btn.disabled = true
      try {
        const res = await fetch('/api/fetch-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
        const data = await res.json()
        if (data.title) document.getElementById('productTitle').value = data.title
        if (data.description) document.getElementById('productDesc').value = data.description
        if (data.imageUrl) document.getElementById('productImage').value = data.imageUrl
        if (data.store) document.getElementById('productStore').value = data.store
        const preview = document.getElementById('urlPreview')
        if (data.title) {
          preview.classList.remove('hidden')
          document.getElementById('previewImg').src = data.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(data.title)}&background=6366f1&color=fff&size=100\`
          document.getElementById('previewTitle').textContent = data.title
          document.getElementById('previewStore').textContent = data.store || ''
          showToast('Dados do produto carregados!', 'success')
        } else {
          showToast('Preencha os campos manualmente.', 'info')
        }
      } catch (e) { showToast('Erro ao buscar dados.', 'error') }
      btn.innerHTML = '<i class="fas fa-magic"></i> Buscar'
      btn.disabled = false
    }

    async function addProduct() {
      const categoryId = document.getElementById('categoryId').value
      const productUrl = document.getElementById('productUrl').value.trim()
      const title = document.getElementById('productTitle').value.trim()
      if (!categoryId) return showToast('Selecione uma categoria!', 'error')
      if (!productUrl) return showToast('URL do produto é obrigatória!', 'error')
      if (!title) return showToast('Título do produto é obrigatório!', 'error')
      const btn = document.getElementById('addBtn')
      btn.innerHTML = '<span class="spinner"></span> Salvando...'
      btn.disabled = true
      try {
        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            categoryId, productUrl, title,
            description: document.getElementById('productDesc').value.trim(),
            imageUrl: document.getElementById('productImage').value.trim(),
            price: '',
            store: document.getElementById('productStore').value.trim(),
            rating: parseFloat(document.getElementById('productRating').value),
            featured: document.getElementById('productFeatured').checked
          })
        })
        const data = await res.json()
        if (data.success) { showToast('Produto adicionado com sucesso!', 'success'); resetForm(); await loadProducts() }
        else showToast(data.error || 'Erro ao adicionar produto', 'error')
      } catch (e) { showToast('Erro de conexão', 'error') }
      btn.innerHTML = '<i class="fas fa-plus"></i> Adicionar Produto'
      btn.disabled = false
    }

    function resetForm() {
      ['productUrl','productTitle','productDesc','productImage','productStore'].forEach(id => document.getElementById(id).value = '')
      document.getElementById('categoryId').value = ''
      document.getElementById('productRating').value = 0
      document.getElementById('ratingValue').textContent = '0★'
      document.getElementById('productFeatured').checked = false
      document.getElementById('urlPreview').classList.add('hidden')
    }

    async function loadProducts() {
      const filterCat = document.getElementById('filterCategory').value
      const url = filterCat ? \`/api/products/\${filterCat}\` : '/api/products'
      const res = await fetch(url)
      allProducts = await res.json()
      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)
      const list = document.getElementById('productsList')
      const empty = document.getElementById('emptyAdmin')
      if (allProducts.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return }
      empty.classList.add('hidden')
      list.innerHTML = allProducts.map(p => {
        const cat = catMap[p.categoryId] || { name: p.categoryId, icon: '📦', color: '#6366f1' }
        const imgSrc = p.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80\`
        return \`
          <div class="card-admin bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4" data-id="\${p.id}">
            <img src="\${imgSrc}" alt="\${p.title}" class="w-16 h-16 rounded-xl object-cover bg-gray-100 flex-shrink-0" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80'">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap mb-1">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium text-white" style="background: \${cat.color}">\${cat.icon} \${cat.name}</span>
                \${p.featured ? '<span class="text-xs px-2 py-0.5 rounded-full font-medium text-white featured-badge">⭐ Destaque</span>' : ''}
                \${p.store ? \`<span class="text-xs text-gray-400 font-medium">\${p.store}</span>\` : ''}
              </div>
              <h3 class="font-bold text-gray-800 text-sm line-clamp-1">\${p.title}</h3>
              <a href="\${p.productUrl}" target="_blank" class="text-xs text-indigo-500 hover:underline truncate max-w-xs block mt-0.5">\${p.productUrl}</a>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button data-action="featured" data-cat="\${p.categoryId}" data-id="\${p.id}"
                class="p-2 rounded-xl border transition-all \${p.featured ? 'bg-yellow-50 border-yellow-200 text-yellow-500' : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-yellow-50 hover:border-yellow-200 hover:text-yellow-500'}"
                title="\${p.featured ? 'Remover destaque' : 'Marcar como destaque'}">
                <i class="fas fa-star text-sm"></i>
              </button>
              <a href="\${p.productUrl}" target="_blank" class="p-2 rounded-xl border bg-indigo-50 border-indigo-200 text-indigo-500 hover:bg-indigo-100 transition-all" title="Abrir produto">
                <i class="fas fa-external-link-alt text-sm"></i>
              </a>
              <button data-action="delete" data-cat="\${p.categoryId}" data-id="\${p.id}"
                class="p-2 rounded-xl border bg-red-50 border-red-200 text-red-400 hover:bg-red-100 transition-all" title="Remover produto">
                <i class="fas fa-trash text-sm"></i>
              </button>
            </div>
          </div>
        \`
      }).join('')
    }

    document.getElementById('productsList').addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action]')
      if (!btn) return
      const action = btn.dataset.action, cat = btn.dataset.cat, id = btn.dataset.id
      if (action === 'delete') {
        const found = allProducts.find(p => p.id === id)
        if (!confirm('Remover "' + ((found && found.title) || 'este produto') + '"?')) return
        try {
          const res = await fetch('/api/products/' + cat + '/' + id, { method: 'DELETE' })
          const data = await res.json()
          if (data.success) { showToast('Produto removido!', 'success'); await loadProducts() }
          else showToast(data.error || 'Erro ao remover', 'error')
        } catch { showToast('Erro de conexão', 'error') }
      } else if (action === 'featured') {
        try {
          const res = await fetch('/api/products/' + cat + '/' + id + '/featured', { method: 'PATCH' })
          const data = await res.json()
          if (data.success) { showToast(data.product.featured ? '⭐ Marcado como destaque!' : 'Removido dos destaques', 'success'); await loadProducts() }
        } catch { showToast('Erro de conexão', 'error') }
      }
    })

    // ======= BLOG / ARTIGOS =======
    let articleMetadata = {}

    async function fetchArticleMetadata() {
      const url = document.getElementById('articleProductUrl').value.trim()
      if (!url) return
      const btn = document.getElementById('fetchArticleBtn')
      btn.innerHTML = '<span class="spinner"></span>'
      btn.disabled = true
      try {
        const res = await fetch('/api/fetch-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
        articleMetadata = await res.json()
        articleMetadata.url = url
        const preview = document.getElementById('articlePreview')
        if (articleMetadata.title) {
          preview.classList.remove('hidden')
          document.getElementById('articlePreviewImg').src = articleMetadata.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(articleMetadata.title)}&background=6366f1&color=fff&size=100\`
          document.getElementById('articlePreviewTitle').textContent = articleMetadata.title
          document.getElementById('articlePreviewStore').textContent = articleMetadata.store ? '🛒 ' + articleMetadata.store : ''
          // Auto-preenche campos
          document.getElementById('articleImage').value = articleMetadata.imageUrl || ''
          showToast('Produto encontrado! Agora clique em "Gerar Artigo".', 'success')
        } else {
          showToast('Não foi possível buscar dados. Preencha manualmente.', 'info')
        }
      } catch { showToast('Erro ao buscar dados do produto.', 'error') }
      btn.innerHTML = '<i class="fas fa-magic text-xs"></i> Buscar'
      btn.disabled = false
    }

    function generateArticle() {
      const title = articleMetadata.title || ''
      const store = articleMetadata.store || 'marketplace'
      const desc = articleMetadata.description || ''
      const cat = document.getElementById('articleCategory').value
      const btn = document.getElementById('generateBtn')
      btn.innerHTML = '<span class="spinner"></span> Gerando...'
      btn.disabled = true

      // Gera título SEO persuasivo
      const titleTemplates = [
        \`Vale a pena comprar? Análise completa + tudo que você precisa saber antes de comprar\`,
        \`Review honesto: descubra por que este produto está entre os mais recomendados de 2026\`,
        \`Guia de compra: análise técnica, prós, contras e veredicto final\`,
        \`Analisamos a fundo — veja o que encontramos antes de recomendar\`,
        \`O que ninguém te conta sobre este produto: análise imparcial da Equipe TeckHome\`
      ]
      const tIdx = (title.length + cat.length) % titleTemplates.length
      const generatedTitle = title
        ? \`\${title.substring(0, 50)}: \${titleTemplates[tIdx]}\`
        : titleTemplates[tIdx]

      // Gera excerpt persuasivo longo (copywriting)
      const excerptTemplates = [
        \`Todo consumidor sabe a frustração de comprar um produto empolgado pelas fotos e descrições, e descobrir depois que ele não entrega o que prometia. Por isso, nossa equipe foi além das especificações técnicas e analisou os pontos que realmente importam: durabilidade, custo-benefício real, facilidade de uso e o que os compradores verificados dizem sobre este produto. O resultado desta análise pode mudar sua decisão de compra — e te fazer economizar tempo e dinheiro. Antes de finalizar sua compra na \${store}, leia nossa avaliação completa.\`,
        \`Quando um produto chama atenção no mercado, nossa missão é ir além do marketing e descobrir o que ele realmente vale. Depois de analisar dezenas de avaliações reais, comparar com alternativas da mesma categoria e estudar as especificações técnicas com olho crítico, chegamos a uma conclusão que vai surpreender você. Se você está cogitando adquirir este produto, não perca tempo: nossa análise resume tudo que você precisa saber para comprar com total segurança — sem arrependimentos e sem desperdício de dinheiro.\`,
        \`Você está prestes a tomar uma decisão de compra importante. E nós entendemos que, com tantas opções no mercado e promessas exageradas das marcas, é difícil saber em quem confiar. Foi exatamente por isso que criamos esta análise: para te dar clareza, objetividade e confiança. Avaliamos este produto nos critérios que realmente importam para quem vai usá-lo no dia a dia — e nosso veredicto é baseado em dados reais, não em especificações de marketing. Leia até o final antes de tomar sua decisão.\`,
        \`Há uma grande diferença entre um produto que parece bom e um produto que realmente é bom. Nossa equipe passou horas pesquisando, comparando e analisando este item disponível na \${store} para te dar uma resposta honesta: vale a pena? A resposta pode te surpreender. Reunimos nesta análise os pontos fortes, os pontos de atenção, e o perfil exato do comprador que vai se beneficiar deste produto — para que você tome a decisão mais inteligente possível.\`,
        \`Se você chegou até aqui, é porque está levando sua decisão de compra a sério. E isso é exatamente o que a Equipe TeckHome valoriza. Nossa missão é separar o joio do trigo em \${cat} — e este produto passou pelo nosso processo de análise rigoroso. Avaliamos tudo: qualidade de construção, desempenho no uso real, custo-benefício e reputação na \${store}. Confira nosso relatório completo e descubra se este produto merece um lugar no seu carrinho de compras.\`
      ]
      const eIdx = (title.length + store.length) % excerptTemplates.length
      const generatedExcerpt = excerptTemplates[eIdx]

      // Gera keywords SEO
      const catKeywords = {
        'Eletrônicos': 'eletrônicos, tecnologia, review eletrônico, melhor celular, smartphone',
        'Eletrodomésticos': 'eletrodomésticos, casa, review eletrodoméstico, cozinha, utilidades',
        'Ferramentas': 'ferramentas elétricas, bricolagem, faça você mesmo, ferramentas casa',
        'Refrigeração': 'ar condicionado, refrigeração, clima, conforto térmico, BTU',
        'Cama e Mesa': 'cama, mesa, roupa de cama, conforto, lar',
        'Ventilação': 'ventilador, ventilação, circulador de ar, conforto',
        'Jardim': 'jardim, plantas, ferramentas jardim, área externa',
        'Geral': 'produtos, review, análise, compras'
      }
      const baseKw = catKeywords[cat] || catKeywords['Geral']
      const shortTitle = title.substring(0, 30).toLowerCase().replace(/[^a-z0-9\s]/g, '')
      const generatedKeywords = \`\${shortTitle}, review \${shortTitle}, vale a pena \${shortTitle}, \${store} \${shortTitle}, \${baseKw}\`

      document.getElementById('articleTitle').value = generatedTitle
      document.getElementById('articleExcerpt').value = generatedExcerpt
      document.getElementById('articleKeywords').value = generatedKeywords

      btn.innerHTML = '<i class="fas fa-robot text-xs"></i> Gerar Artigo Persuasivo'
      btn.disabled = false
      showToast('Artigo gerado com copywriting persuasivo! Revise e publique.', 'success')
    }

    async function publishArticle() {
      const title = document.getElementById('articleTitle').value.trim()
      const excerpt = document.getElementById('articleExcerpt').value.trim()
      if (!title) return showToast('Título do artigo é obrigatório!', 'error')
      if (!excerpt) return showToast('Resumo do artigo é obrigatório!', 'error')

      const catSelect = document.getElementById('articleCategory')
      const catOpt = catSelect.options[catSelect.selectedIndex]
      const catIcon = catOpt.getAttribute('data-icon') || '📝'

      const btn = document.getElementById('publishBtn')
      btn.innerHTML = '<span class="spinner"></span> Publicando...'
      btn.disabled = true

      try {
        const res = await fetch('/api/articles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            excerpt,
            category: catSelect.value,
            categoryIcon: catIcon,
            image: document.getElementById('articleImage').value.trim(),
            productUrl: articleMetadata.url || document.getElementById('articleProductUrl').value.trim(),
            store: articleMetadata.store || '',
            readTime: document.getElementById('articleReadTime').value,
            keywords: document.getElementById('articleKeywords').value.trim()
          })
        })
        const data = await res.json()
        if (data.success) {
          showToast('✅ Artigo publicado no blog!', 'success')
          resetArticleForm()
          await loadArticles()
        } else {
          showToast(data.error || 'Erro ao publicar artigo', 'error')
        }
      } catch { showToast('Erro de conexão', 'error') }

      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Publicar Artigo no Blog'
      btn.disabled = false
    }

    function resetArticleForm() {
      articleMetadata = {}
      document.getElementById('articleProductUrl').value = ''
      document.getElementById('articleTitle').value = ''
      document.getElementById('articleExcerpt').value = ''
      document.getElementById('articleKeywords').value = ''
      document.getElementById('articleImage').value = ''
      document.getElementById('articlePreview').classList.add('hidden')
    }

    async function loadArticles() {
      try {
        const res = await fetch('/api/articles')
        allArticles = res.ok ? await res.json() : []
      } catch { allArticles = [] }

      const list = document.getElementById('articlesList')
      const empty = document.getElementById('emptyArticles')

      if (allArticles.length === 0) {
        list.innerHTML = ''
        empty.classList.remove('hidden')
        return
      }

      empty.classList.add('hidden')
      list.innerHTML = allArticles.map(art => \`
        <div class="card-admin bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4">
          <div class="w-16 h-16 rounded-xl overflow-hidden bg-indigo-50 flex-shrink-0 flex items-center justify-center text-2xl">
            \${art.image ? \`<img src="\${art.image}" alt="" class="w-full h-full object-cover">\` : art.categoryIcon || '📝'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">\${art.categoryIcon || ''} \${art.category || 'Geral'}</span>
              <span class="text-xs text-gray-400"><i class="fas fa-clock text-xs"></i> \${art.readTime || '5 min'}</span>
            </div>
            <h3 class="font-bold text-gray-800 text-sm line-clamp-2">\${art.title}</h3>
            <p class="text-xs text-gray-400 mt-0.5">\${new Date(art.createdAt).toLocaleDateString('pt-BR')}</p>
          </div>
          <button onclick="deleteArticle('\${art.id}')" class="p-2 rounded-xl border bg-red-50 border-red-200 text-red-400 hover:bg-red-100 transition-all flex-shrink-0" title="Remover artigo">
            <i class="fas fa-trash text-sm"></i>
          </button>
        </div>
      \`).join('')
    }

    async function deleteArticle(id) {
      const art = allArticles.find(a => a.id === id)
      if (!confirm('Remover artigo "' + ((art && art.title) || 'este artigo').substring(0, 50) + '"?')) return
      try {
        const res = await fetch('/api/articles/' + id, { method: 'DELETE' })
        const data = await res.json()
        if (data.success) { showToast('Artigo removido!', 'success'); await loadArticles() }
        else showToast(data.error || 'Erro ao remover', 'error')
      } catch { showToast('Erro de conexão', 'error') }
    }

    // ======= INIT =======
    async function init() {
      const res = await fetch('/api/categories')
      categories = await res.json()
      const catSelect = document.getElementById('categoryId')
      const filterSelect = document.getElementById('filterCategory')
      categories.forEach(cat => {
        catSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
        filterSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
      })
      await loadProducts()
    }

    init()
  </script>
</body>
</html>`
}

// === HELPER: navbar compartilhada ===
function sharedNavbar(): string {
  return `
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Descubra antes de comprar</span>
          </div>
        </a>
        <a href="/" class="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-indigo-600 transition-colors">
          <i class="fas fa-arrow-left text-xs"></i> Voltar ao início
        </a>
      </div>
    </div>
  </nav>`
}

// === HELPER: footer compartilhado ===
function sharedFooter(): string {
  return `
  <footer class="bg-gray-900 text-white py-8 px-4 mt-16">
    <div class="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-gray-400">
      <div class="flex items-center gap-2">
        <img src="/static/logo.png" alt="TeckHome Store" class="w-8 h-8 rounded-lg object-cover">
        <span class="font-bold text-white">Teck<span class="text-indigo-400">Home</span> Store</span>
      </div>
      <div class="flex flex-wrap justify-center gap-4">
        <a href="/termos-de-uso" class="hover:text-white transition-colors">Termos de Uso</a>
        <a href="/politica-de-privacidade" class="hover:text-white transition-colors">Privacidade</a>
        <a href="/politica-de-cookies" class="hover:text-white transition-colors">Cookies</a>
        <a href="/sobre" class="hover:text-white transition-colors">Sobre Nós</a>
      </div>
      <p>© 2026 TeckHome Store</p>
    </div>
  </footer>`
}

// === PÁGINA: TERMOS DE USO ===
// === PÁGINA DE LOGIN DO ADMIN ===
function loginPage(erro?: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acesso Restrito — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .gradient-bg { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #1e3a5f 100%); }
  </style>
</head>
<body class="gradient-bg min-h-screen flex items-center justify-center px-4">

  <div class="w-full max-w-sm">

    <!-- Logo -->
    <div class="text-center mb-8">
      <img src="/static/logo.png" alt="TeckHome Store" class="w-20 h-20 rounded-2xl object-cover shadow-2xl mx-auto mb-4 border-2 border-white/20">
      <h1 class="text-2xl font-black text-white">Teck<span class="text-indigo-300">Home</span> Store</h1>
      <p class="text-indigo-300 text-sm mt-1">Painel Administrativo</p>
    </div>

    <!-- Card de login -->
    <div class="bg-white rounded-3xl shadow-2xl p-8">

      <div class="flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
          <i class="fas fa-lock text-indigo-600"></i>
        </div>
        <div>
          <h2 class="font-black text-gray-900 text-lg">Acesso Restrito</h2>
          <p class="text-gray-400 text-xs">Apenas administradores</p>
        </div>
      </div>

      ${erro ? `
      <div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-5 flex items-center gap-2">
        <i class="fas fa-exclamation-circle"></i> ${erro}
      </div>` : ''}

      <form method="POST" action="/admin/login" class="space-y-4">

        <div>
          <label class="text-sm font-semibold text-gray-700 block mb-1.5">Usuário</label>
          <div class="relative">
            <i class="fas fa-user absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input
              type="text"
              name="username"
              placeholder="Digite seu usuário"
              required
              class="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
            >
          </div>
        </div>

        <div>
          <label class="text-sm font-semibold text-gray-700 block mb-1.5">Senha</label>
          <div class="relative">
            <i class="fas fa-key absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input
              type="password"
              name="password"
              placeholder="Digite sua senha"
              required
              class="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
            >
          </div>
        </div>

        <button
          type="submit"
          class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
          <i class="fas fa-sign-in-alt"></i> Entrar
        </button>

      </form>

      <div class="mt-6 pt-5 border-t border-gray-100 text-center">
        <a href="/" class="text-sm text-gray-400 hover:text-indigo-600 transition-colors flex items-center justify-center gap-1">
          <i class="fas fa-arrow-left text-xs"></i> Voltar ao site
        </a>
      </div>

    </div>

    <p class="text-center text-indigo-300/50 text-xs mt-6">© 2026 TeckHome Store</p>
  </div>

</body>
</html>`
}

function termosPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Termos de Uso — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <main class="max-w-3xl mx-auto px-4 py-14">

    <!-- Cabeçalho -->
    <div class="mb-10">
      <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Legal</span>
      <h1 class="text-4xl font-black text-gray-900 mb-2">Termos de Uso</h1>
      <p class="text-gray-500 text-sm">Última atualização: maio de 2026 · <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
      <div class="w-16 h-1 bg-indigo-600 rounded-full mt-4"></div>
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-8 text-gray-700 leading-relaxed">

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-file-alt text-indigo-500 text-base"></i> 1. Aceitação dos Termos</h2>
        <p>Ao acessar e utilizar o site <strong>TeckHome Store</strong> (teckhomestore.com), você concorda integralmente com estes Termos de Uso. Caso não concorde com qualquer disposição aqui presente, solicitamos que interrompa imediatamente o uso do site.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-info-circle text-indigo-500 text-base"></i> 2. Sobre o Site</h2>
        <p>O TeckHome Store é um portal editorial de conteúdo informativo focado em reviews, comparativos e recomendações de produtos nas categorias de tecnologia, eletrodomésticos, ferramentas, refrigeração, cama e mesa, ventilação e jardim. Todo o conteúdo é produzido pela <strong>Equipe TeckHome</strong> com finalidade exclusivamente informativa.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-link text-indigo-500 text-base"></i> 3. Links de Afiliados</h2>
        <p>Os links de produtos presentes neste site podem ser links de afiliados. Isso significa que podemos receber uma comissão caso você realize uma compra através desses links, <strong>sem custo adicional para você</strong>. Essas parcerias não influenciam nossa avaliação dos produtos.</p>
        <p class="mt-3">Os preços, disponibilidade e condições dos produtos são de responsabilidade exclusiva dos respectivos varejistas (Amazon, Mercado Livre, Shopee, Magazine Luiza, etc.) e podem ser alterados sem aviso prévio.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-ban text-indigo-500 text-base"></i> 4. Uso Proibido</h2>
        <p>É expressamente proibido:</p>
        <ul class="list-disc list-inside mt-3 space-y-1 text-gray-600">
          <li>Reproduzir, copiar ou distribuir o conteúdo sem autorização prévia por escrito</li>
          <li>Utilizar o site para fins ilegais ou fraudulentos</li>
          <li>Tentar acessar áreas restritas do sistema sem autorização</li>
          <li>Publicar conteúdo difamatório, enganoso ou que viole direitos de terceiros</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-pencil-alt text-indigo-500 text-base"></i> 5. Propriedade Intelectual</h2>
        <p>Todo o conteúdo publicado no TeckHome Store — incluindo textos, imagens, logotipos e design — é propriedade do TeckHome Store ou licenciado para uso. É proibida a reprodução total ou parcial sem autorização expressa.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-exclamation-triangle text-indigo-500 text-base"></i> 6. Limitação de Responsabilidade</h2>
        <p>O TeckHome Store não se responsabiliza por decisões de compra tomadas com base em nosso conteúdo, nem por problemas com produtos adquiridos através dos links disponibilizados. As relações de compra e venda são exclusivamente entre o consumidor e o varejista.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-sync text-indigo-500 text-base"></i> 7. Alterações nos Termos</h2>
        <p>Reservamo-nos o direito de alterar estes Termos de Uso a qualquer momento. As alterações entrarão em vigor imediatamente após a publicação no site. O uso continuado do site após as alterações implica na aceitação dos novos termos.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-envelope text-indigo-500 text-base"></i> 8. Contato</h2>
        <p>Para dúvidas sobre estes Termos de Uso, entre em contato:</p>
        <div class="mt-3 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="font-semibold text-gray-800">TeckHome Store</p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-envelope text-indigo-500 mr-2"></i><a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-globe text-indigo-500 mr-2"></i><a href="https://teckhomestore.com" class="text-indigo-600 hover:underline">teckhomestore.com</a></p>
        </div>
      </section>

    </div>
  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === PÁGINA: POLÍTICA DE PRIVACIDADE ===
function privacidadePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidade — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <main class="max-w-3xl mx-auto px-4 py-14">

    <div class="mb-10">
      <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Legal</span>
      <h1 class="text-4xl font-black text-gray-900 mb-2">Política de Privacidade</h1>
      <p class="text-gray-500 text-sm">Última atualização: maio de 2026 · <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
      <div class="w-16 h-1 bg-indigo-600 rounded-full mt-4"></div>
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-8 text-gray-700 leading-relaxed">

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-shield-alt text-indigo-500 text-base"></i> 1. Compromisso com sua Privacidade</h2>
        <p>O <strong>TeckHome Store</strong> respeita sua privacidade e está comprometido em proteger seus dados pessoais. Esta política explica como coletamos, usamos e protegemos as informações dos nossos visitantes, em conformidade com a <strong>Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018)</strong>.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-database text-indigo-500 text-base"></i> 2. Dados que Coletamos</h2>
        <p>Podemos coletar as seguintes informações:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li><strong>Dados de navegação:</strong> páginas acessadas, tempo de visita, dispositivo e navegador utilizado</li>
          <li><strong>Dados de uso:</strong> buscas realizadas, produtos visualizados e categorias acessadas</li>
          <li><strong>Dados de contato:</strong> nome e e-mail, apenas quando você nos contata voluntariamente</li>
          <li><strong>Cookies e tecnologias similares:</strong> conforme descrito em nossa Política de Cookies</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-cogs text-indigo-500 text-base"></i> 3. Como Usamos seus Dados</h2>
        <p>Utilizamos as informações coletadas para:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Melhorar a experiência de navegação e o conteúdo do site</li>
          <li>Analisar o desempenho das páginas e categorias</li>
          <li>Responder mensagens e solicitações de contato</li>
          <li>Cumprir obrigações legais quando necessário</li>
        </ul>
        <p class="mt-3">Não vendemos, alugamos ou compartilhamos seus dados pessoais com terceiros para fins de marketing.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-share-alt text-indigo-500 text-base"></i> 4. Compartilhamento de Dados</h2>
        <p>Seus dados podem ser compartilhados apenas nas seguintes situações:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Com plataformas de análise (Google Analytics, etc.) de forma anonimizada</li>
          <li>Com autoridades competentes, quando exigido por lei</li>
          <li>Ao clicar em links de afiliados, você será redirecionado para sites de terceiros com suas próprias políticas de privacidade</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-lock text-indigo-500 text-base"></i> 5. Segurança dos Dados</h2>
        <p>Adotamos medidas técnicas e organizacionais adequadas para proteger seus dados contra acesso não autorizado, alteração, divulgação ou destruição. No entanto, nenhum sistema é 100% seguro e não podemos garantir segurança absoluta.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-user-check text-indigo-500 text-base"></i> 6. Seus Direitos (LGPD)</h2>
        <p>Como titular de dados, você tem direito a:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Confirmar a existência de tratamento de seus dados</li>
          <li>Acessar seus dados pessoais</li>
          <li>Solicitar correção de dados incompletos ou incorretos</li>
          <li>Solicitar a exclusão dos seus dados</li>
          <li>Revogar o consentimento a qualquer momento</li>
        </ul>
        <p class="mt-3">Para exercer esses direitos, entre em contato pelo e-mail <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline font-medium">contato@teckhomestore.com</a>.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-external-link-alt text-indigo-500 text-base"></i> 7. Sites de Terceiros</h2>
        <p>Nosso site contém links para lojas parceiras e afiliados. Ao acessar esses sites, você estará sujeito às políticas de privacidade deles. Não nos responsabilizamos pelo tratamento de dados realizado por terceiros.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-envelope text-indigo-500 text-base"></i> 8. Contato do Responsável</h2>
        <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="font-semibold text-gray-800">TeckHome Store — Encarregado de Dados (DPO)</p>
          <p class="text-sm text-gray-600 mt-2"><i class="fas fa-envelope text-indigo-500 mr-2"></i><a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-globe text-indigo-500 mr-2"></i><a href="https://teckhomestore.com" class="text-indigo-600 hover:underline">teckhomestore.com</a></p>
        </div>
      </section>

    </div>
  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === PÁGINA: POLÍTICA DE COOKIES ===
function cookiesPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Cookies — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <main class="max-w-3xl mx-auto px-4 py-14">

    <div class="mb-10">
      <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Legal</span>
      <h1 class="text-4xl font-black text-gray-900 mb-2">Política de Cookies</h1>
      <p class="text-gray-500 text-sm">Última atualização: maio de 2026 · <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
      <div class="w-16 h-1 bg-indigo-600 rounded-full mt-4"></div>
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-8 text-gray-700 leading-relaxed">

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-cookie-bite text-indigo-500 text-base"></i> 1. O que são Cookies?</h2>
        <p>Cookies são pequenos arquivos de texto armazenados no seu dispositivo quando você visita um site. Eles servem para melhorar sua experiência de navegação, lembrar suas preferências e coletar informações sobre como o site é utilizado.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-list text-indigo-500 text-base"></i> 2. Tipos de Cookies que Utilizamos</h2>

        <div class="space-y-4 mt-3">
          <div class="p-4 bg-green-50 rounded-xl border border-green-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-check-circle text-green-500"></i> Cookies Essenciais</h3>
            <p class="text-sm text-gray-600">Necessários para o funcionamento básico do site. Não podem ser desativados. Incluem cookies de sessão e de segurança.</p>
          </div>
          <div class="p-4 bg-blue-50 rounded-xl border border-blue-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-chart-bar text-blue-500"></i> Cookies de Desempenho / Análise</h3>
            <p class="text-sm text-gray-600">Coletam informações anônimas sobre como os visitantes usam o site (páginas mais acessadas, tempo de visita, etc.). Utilizamos ferramentas como Google Analytics.</p>
          </div>
          <div class="p-4 bg-purple-50 rounded-xl border border-purple-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-sliders-h text-purple-500"></i> Cookies de Funcionalidade</h3>
            <p class="text-sm text-gray-600">Permitem que o site lembre suas preferências (idioma, modo de visualização, etc.) para melhorar sua experiência.</p>
          </div>
          <div class="p-4 bg-orange-50 rounded-xl border border-orange-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-ad text-orange-500"></i> Cookies de Parceiros / Afiliados</h3>
            <p class="text-sm text-gray-600">Quando você clica em um link de afiliado, cookies de terceiros podem ser definidos pelos varejistas parceiros (Amazon, Mercado Livre, etc.) para rastrear a origem da compra.</p>
          </div>
        </div>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-tools text-indigo-500 text-base"></i> 3. Como Gerenciar Cookies</h2>
        <p>Você pode controlar e/ou excluir cookies conforme desejar. A maioria dos navegadores permite:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Visualizar os cookies armazenados e excluí-los individualmente</li>
          <li>Bloquear cookies de terceiros</li>
          <li>Bloquear cookies de sites específicos</li>
          <li>Bloquear todos os cookies</li>
          <li>Excluir todos os cookies ao fechar o navegador</li>
        </ul>
        <p class="mt-3 text-sm text-gray-500">Atenção: desativar cookies pode afetar o funcionamento de algumas funcionalidades do site.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-clock text-indigo-500 text-base"></i> 4. Tempo de Armazenamento</h2>
        <div class="overflow-x-auto mt-3">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="bg-gray-50">
                <th class="text-left p-3 border border-gray-200 font-semibold text-gray-700">Tipo de Cookie</th>
                <th class="text-left p-3 border border-gray-200 font-semibold text-gray-700">Duração</th>
              </tr>
            </thead>
            <tbody>
              <tr><td class="p-3 border border-gray-200">Sessão</td><td class="p-3 border border-gray-200">Até fechar o navegador</td></tr>
              <tr class="bg-gray-50"><td class="p-3 border border-gray-200">Preferências</td><td class="p-3 border border-gray-200">Até 1 ano</td></tr>
              <tr><td class="p-3 border border-gray-200">Análise (Analytics)</td><td class="p-3 border border-gray-200">Até 2 anos</td></tr>
              <tr class="bg-gray-50"><td class="p-3 border border-gray-200">Afiliados</td><td class="p-3 border border-gray-200">Conforme política do parceiro</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-envelope text-indigo-500 text-base"></i> 5. Contato</h2>
        <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="font-semibold text-gray-800">TeckHome Store</p>
          <p class="text-sm text-gray-600 mt-2"><i class="fas fa-envelope text-indigo-500 mr-2"></i><a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-globe text-indigo-500 mr-2"></i><a href="https://teckhomestore.com" class="text-indigo-600 hover:underline">teckhomestore.com</a></p>
        </div>
      </section>

    </div>
  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === PÁGINA: SOBRE NÓS ===
function sobrePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sobre Nós — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .gradient-hero { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #1e3a5f 70%, #0f172a 100%); }
    @keyframes gradientMove { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <!-- Hero -->
  <section class="gradient-hero text-white py-16 px-4 text-center">
    <div class="max-w-3xl mx-auto">
      <img src="/static/logo.png" alt="TeckHome Store" class="w-24 h-24 rounded-2xl object-cover shadow-2xl mx-auto mb-6 border-2 border-white/20">
      <h1 class="text-4xl md:text-5xl font-black mb-3">Sobre o TeckHome Store</h1>
      <p class="text-indigo-300 text-lg">Descubra antes de comprar</p>
    </div>
  </section>

  <main class="max-w-3xl mx-auto px-4 py-14 space-y-8">

    <!-- Missão -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-4 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-bullseye text-indigo-600"></i></div>
        Nossa Missão
      </h2>
      <p class="text-gray-600 leading-relaxed">
        O <strong>TeckHome Store</strong> nasceu com um objetivo claro: <strong>ajudar consumidores brasileiros a fazer escolhas de compra mais inteligentes</strong>. Em um mercado com milhares de produtos e opções, nossa missão é organizar, analisar e recomendar os melhores itens de tecnologia, eletrodomésticos e utilidades para o lar.
      </p>
      <p class="text-gray-600 leading-relaxed mt-4">
        Acreditamos que uma boa decisão de compra começa com informação de qualidade. Por isso, a Equipe TeckHome produz conteúdo editorial imparcial, baseado em análises técnicas, avaliações reais de usuários e comparativos de mercado.
      </p>
    </div>

    <!-- O que fazemos -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-6 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-star text-indigo-600"></i></div>
        O que Fazemos
      </h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <i class="fas fa-search text-indigo-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">Reviews de Produtos</h3>
          <p class="text-sm text-gray-500">Análises detalhadas com pontos positivos, negativos e para quem o produto é indicado.</p>
        </div>
        <div class="p-4 bg-blue-50 rounded-xl border border-blue-100">
          <i class="fas fa-balance-scale text-blue-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">Comparativos</h3>
          <p class="text-sm text-gray-500">Comparamos produtos similares para ajudar você a escolher o melhor custo-benefício.</p>
        </div>
        <div class="p-4 bg-sky-50 rounded-xl border border-sky-100">
          <i class="fas fa-tags text-sky-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">Melhores Preços</h3>
          <p class="text-sm text-gray-500">Links diretos para as maiores lojas do Brasil com os melhores preços disponíveis.</p>
        </div>
        <div class="p-4 bg-emerald-50 rounded-xl border border-emerald-100">
          <i class="fas fa-th-large text-emerald-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">7 Categorias</h3>
          <p class="text-sm text-gray-500">Eletrônicos, Eletrodomésticos, Ferramentas, Refrigeração, Cama e Mesa, Ventilação e Jardim.</p>
        </div>
      </div>
    </div>

    <!-- Equipe -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-4 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-users text-indigo-600"></i></div>
        Equipe TeckHome
      </h2>
      <div class="flex items-start gap-5">
        <div class="w-16 h-16 rounded-2xl flex-shrink-0 flex items-center justify-center shadow-md" style="background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #1e3a5f 100%);">
          <span class="text-2xl">🏠</span>
        </div>
        <div>
          <p class="text-gray-600 leading-relaxed">
            A <strong>Equipe TeckHome</strong> reúne conteúdos, análises e recomendações de produtos voltados para tecnologia, casa e utilidades do dia a dia. Nosso objetivo é ajudar consumidores a fazer escolhas mais inteligentes através de reviews organizados, comparativos e conteúdos informativos.
          </p>
          <p class="text-gray-600 leading-relaxed mt-3">
            Todo o conteúdo publicado é produzido com foco informativo, baseado em análises de mercado, avaliações públicas e características técnicas dos produtos, sempre com total transparência sobre nosso modelo de monetização via links de afiliados.
          </p>
        </div>
      </div>
    </div>

    <!-- Contato -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-6 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-envelope text-indigo-600"></i></div>
        Entre em Contato
      </h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <a href="mailto:contato@teckhomestore.com" class="flex items-center gap-4 p-5 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-400 hover:shadow-md transition-all group">
          <div class="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-700 transition-colors">
            <i class="fas fa-envelope text-white"></i>
          </div>
          <div>
            <div class="font-bold text-gray-800 text-sm">E-mail</div>
            <div class="text-indigo-600 text-sm font-medium mt-0.5">contato@teckhomestore.com</div>
          </div>
        </a>
        <a href="https://teckhomestore.com" target="_blank" rel="noopener noreferrer" class="flex items-center gap-4 p-5 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-400 hover:shadow-md transition-all group">
          <div class="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-700 transition-colors">
            <i class="fas fa-globe text-white"></i>
          </div>
          <div>
            <div class="font-bold text-gray-800 text-sm">Site</div>
            <div class="text-indigo-600 text-sm font-medium mt-0.5">teckhomestore.com</div>
          </div>
        </a>
      </div>
      <p class="text-gray-500 text-sm mt-5 leading-relaxed">
        Tem sugestões de produtos para analisarmos, quer fazer uma parceria ou tem alguma dúvida? Entre em contato! Respondemos em até 48 horas úteis.
      </p>
    </div>

  </main>

  ${sharedFooter()}
</body>
</html>`
}

export default app
