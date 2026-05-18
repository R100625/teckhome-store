import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CATEGORIES, type Product } from './types'
import { getProducts, getAllProducts, saveProduct, deleteProduct, toggleFeatured } from './storage'

type Bindings = {
  PRODUCTS_KV: KVNamespace
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

// === PAINEL ADMIN ===
app.get('/admin', (c) => {
  return c.html(adminPage())
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
  <title>TeckHome Store - Reviews de Produtos</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .gradient-hero { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #1e3a5f 70%, #0f172a 100%); }
    .card-hover { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card-hover:hover { transform: translateY(-8px); box-shadow: 0 25px 50px rgba(0,0,0,0.15); }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .category-card:hover .category-icon { transform: scale(1.2) rotate(5deg); }
    .category-icon { transition: transform 0.3s ease; display: inline-block; }
    .search-box:focus { box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3); }
    .pulse-dot { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    @keyframes gradientMove { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
    .editorial-footer { background: linear-gradient(135deg, #f8faff, #eef2ff); border-top: 1px solid #e0e7ff; }
    .editorial-footer:hover { background: linear-gradient(135deg, #eef2ff, #e0e7ff); }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 4px; }
    .nav-link { position: relative; }
    .nav-link::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 0; height: 2px; background: #6366f1; transition: width 0.3s; }
    .nav-link:hover::after { width: 100%; }
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
          <a href="#categorias" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Categorias</a>
          <a href="#destaques" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Destaques</a>
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
  <section class="gradient-hero text-white py-20 px-4 relative overflow-hidden">
    <div class="absolute inset-0 overflow-hidden">
      <div class="absolute -top-20 -right-20 w-80 h-80 bg-indigo-500 rounded-full opacity-10 blur-3xl"></div>
      <div class="absolute -bottom-20 -left-20 w-80 h-80 bg-blue-500 rounded-full opacity-10 blur-3xl"></div>
    </div>
    <div class="max-w-4xl mx-auto text-center relative z-10">
      <div class="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm rounded-full px-4 py-2 text-sm mb-6 border border-white/20">
        <span class="pulse-dot w-2 h-2 bg-green-400 rounded-full"></span>
        <span>Reviews e recomendações atualizadas</span>
      </div>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-5 mb-8">
        <img src="/static/logo.png" alt="TeckHome Store" class="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl object-cover shadow-2xl border-2 border-white/20 flex-shrink-0">
        <div class="text-center sm:text-left">
          <h1 class="text-4xl md:text-6xl font-black leading-tight">
            TeckHome Store
          </h1>
          <p class="text-xl md:text-2xl text-indigo-300 font-semibold mt-2">Descubra antes de comprar</p>
        </div>
      </div>
      <p class="text-base md:text-lg text-indigo-100 mb-8 max-w-2xl mx-auto">
        Encontre os melhores produtos de tecnologia, eletrodomésticos e muito mais com reviews honestos e links diretos para compra.
      </p>
      <!-- Barra de busca -->
      <div class="max-w-lg mx-auto relative">
        <input 
          id="searchInput"
          type="text" 
          placeholder="Buscar produtos..." 
          class="search-box w-full py-4 px-6 pr-14 rounded-2xl text-gray-800 text-sm font-medium bg-white shadow-2xl outline-none border-2 border-transparent focus:border-indigo-300"
          oninput="handleSearch(this.value)"
        >
        <button class="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center hover:bg-indigo-700 transition-colors">
          <i class="fas fa-search text-white text-sm"></i>
        </button>
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

    function createProductCard(product, category) {
      const stars = product.rating ? '★'.repeat(Math.round(product.rating)) + '☆'.repeat(5 - Math.round(product.rating)) : ''
      const storeIcon = product.store ? \`<span class="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium">\${product.store}</span>\` : ''
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1"><i class="fas fa-star text-xs"></i> Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200\`
      const catColor = category ? category.color : '#6366f1'
      
      return \`
        <div class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col">
          <div class="relative">
            <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer">
              <div class="h-52 overflow-hidden bg-gray-50">
                <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-full object-cover hover:scale-105 transition-transform duration-300" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200'">
              </div>
            </a>
            \${featuredBadge}
            \${category ? \`<div class="absolute top-3 right-3 text-2xl">\${category.icon}</div>\` : ''}
          </div>
          <div class="p-4 flex flex-col flex-1 gap-2">
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-bold text-gray-800 text-sm leading-tight line-clamp-2 flex-1">\${product.title}</h3>
            </div>
            \${product.description ? \`<p class="text-gray-500 text-xs line-clamp-2">\${product.description}</p>\` : ''}
            <div class="flex items-center gap-2 mt-auto pt-2">
              \${storeIcon}
              \${stars ? \`<span class="text-yellow-400 text-xs">\${stars}</span>\` : ''}
            </div>
            <div class="flex items-center justify-between gap-2 mt-1">
              \${product.price ? \`<span class="text-lg font-black text-indigo-700">\${product.price}</span>\` : '<span class="text-sm text-gray-400">Ver preço</span>'}
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer" 
                class="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors">
                Comprar <i class="fas fa-external-link-alt text-xs"></i>
              </a>
            </div>
          </div>
          <!-- Editorial footer -->
          <div class="editorial-footer px-4 py-3 mt-auto flex items-start gap-2.5 rounded-b-2xl transition-all">
            <div class="w-6 h-6 rounded-lg flex-shrink-0 flex items-center justify-center text-sm" style="background: linear-gradient(135deg, #1e1b4b, #3730a3);">🏠</div>
            <div class="min-w-0">
              <div class="text-xs font-bold text-indigo-700">Por Equipe TeckHome</div>
              <div class="text-xs text-gray-400 leading-snug mt-0.5">Conteúdo produzido com foco informativo e baseado em análises de mercado, avaliações públicas e características técnicas dos produtos.</div>
            </div>
          </div>
        </div>
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

    async function init() {
      const categories = await loadCategories()
      await loadFeatured(categories)
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

  <div class="max-w-7xl mx-auto px-4 py-8">
    
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
              <p id="previewPrice" class="text-sm font-black text-indigo-700 mt-0.5"></p>
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
              <label class="block text-sm font-semibold text-gray-700 mb-2">Descrição (opcional)</label>
              <textarea id="productDesc" rows="2" placeholder="Breve descrição do produto..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none transition-all"></textarea>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Preço (opcional)</label>
                <input type="text" id="productPrice" placeholder="R$ 0,00" 
                  class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Loja (opcional)</label>
                <input type="text" id="productStore" placeholder="Amazon, Mercado Livre..." 
                  class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
              </div>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">URL da Imagem (opcional)</label>
              <input type="url" id="productImage" placeholder="https://..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Avaliação (0-5)</label>
              <div class="flex items-center gap-3">
                <input type="range" id="productRating" min="0" max="5" step="0.5" value="0" 
                  class="flex-1 accent-indigo-600"
                  oninput="document.getElementById('ratingValue').textContent = this.value + '★'">
                <span id="ratingValue" class="text-yellow-500 font-bold text-sm w-10 text-right">0★</span>
              </div>
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
          <div class="flex items-center gap-2">
            <select id="filterCategory" onchange="loadProducts()" class="text-sm px-3 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 bg-white">
              <option value="">Todas as categorias</option>
            </select>
          </div>
        </div>

        <div id="productsList" class="space-y-3">
          <div class="shimmer rounded-2xl h-24"></div>
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

  <script>
    let categories = []
    let allProducts = []

    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast')
      const icon = document.getElementById('toastIcon')
      const msg = document.getElementById('toastMsg')
      const inner = document.getElementById('toastInner')
      
      icon.className = type === 'success' ? 'fas fa-check-circle text-green-500 text-xl' : 
                       type === 'error' ? 'fas fa-times-circle text-red-500 text-xl' : 
                       'fas fa-info-circle text-blue-500 text-xl'
      inner.className = \`bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72 \${type === 'success' ? 'border-green-100' : type === 'error' ? 'border-red-100' : 'border-blue-100'}\`
      msg.textContent = message
      toast.classList.add('show')
      setTimeout(() => toast.classList.remove('show'), 3500)
    }

    async function fetchMetadata() {
      const url = document.getElementById('productUrl').value.trim()
      if (!url) return

      const btn = document.getElementById('fetchBtn')
      btn.innerHTML = '<span class="spinner"></span>'
      btn.disabled = true

      try {
        const res = await fetch('/api/fetch-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        })
        const data = await res.json()

        if (data.title) document.getElementById('productTitle').value = data.title
        if (data.description) document.getElementById('productDesc').value = data.description
        if (data.imageUrl) document.getElementById('productImage').value = data.imageUrl
        if (data.price) document.getElementById('productPrice').value = data.price
        if (data.store) document.getElementById('productStore').value = data.store

        // Preview
        const preview = document.getElementById('urlPreview')
        if (data.title) {
          preview.classList.remove('hidden')
          const imgSrc = data.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(data.title)}&background=6366f1&color=fff&size=100\`
          document.getElementById('previewImg').src = imgSrc
          document.getElementById('previewTitle').textContent = data.title
          document.getElementById('previewStore').textContent = data.store || ''
          document.getElementById('previewPrice').textContent = data.price || ''
          showToast('Metadados carregados com sucesso!', 'success')
        } else {
          showToast('Não foi possível carregar metadados automaticamente. Preencha manualmente.', 'info')
        }
      } catch (e) {
        showToast('Erro ao buscar dados. Preencha os campos manualmente.', 'error')
      }

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
            categoryId,
            productUrl,
            title,
            description: document.getElementById('productDesc').value.trim(),
            imageUrl: document.getElementById('productImage').value.trim(),
            price: document.getElementById('productPrice').value.trim(),
            store: document.getElementById('productStore').value.trim(),
            rating: parseFloat(document.getElementById('productRating').value),
            featured: document.getElementById('productFeatured').checked
          })
        })

        const data = await res.json()
        if (data.success) {
          showToast('Produto adicionado com sucesso!', 'success')
          resetForm()
          await loadProducts()
        } else {
          showToast(data.error || 'Erro ao adicionar produto', 'error')
        }
      } catch (e) {
        showToast('Erro de conexão', 'error')
      }

      btn.innerHTML = '<i class="fas fa-plus"></i> Adicionar Produto'
      btn.disabled = false
    }

    function resetForm() {
      document.getElementById('productUrl').value = ''
      document.getElementById('categoryId').value = ''
      document.getElementById('productTitle').value = ''
      document.getElementById('productDesc').value = ''
      document.getElementById('productImage').value = ''
      document.getElementById('productPrice').value = ''
      document.getElementById('productStore').value = ''
      document.getElementById('productRating').value = 0
      document.getElementById('ratingValue').textContent = '0★'
      document.getElementById('productFeatured').checked = false
      document.getElementById('urlPreview').classList.add('hidden')
    }

    async function loadProducts() {
      const filterCat = document.getElementById('filterCategory').value

      let url = '/api/products'
      if (filterCat) url = \`/api/products/\${filterCat}\`

      const res = await fetch(url)
      allProducts = await res.json()

      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)

      const list = document.getElementById('productsList')
      const empty = document.getElementById('emptyAdmin')

      if (allProducts.length === 0) {
        list.innerHTML = ''
        empty.classList.remove('hidden')
        return
      }

      empty.classList.add('hidden')
      list.innerHTML = allProducts.map(p => {
        const cat = catMap[p.categoryId] || { name: p.categoryId, icon: '📦', color: '#6366f1' }
        const imgSrc = p.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80\`
        
        return \`
          <div class="card-admin bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4" data-id="\${p.id}">
            <img src="\${imgSrc}" alt="\${p.title}" class="w-16 h-16 rounded-xl object-cover bg-gray-100 flex-shrink-0" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80'">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium text-white" style="background: \${cat.color}">\${cat.icon} \${cat.name}</span>
                \${p.featured ? '<span class="text-xs px-2 py-0.5 rounded-full font-medium text-white featured-badge">⭐ Destaque</span>' : ''}
                \${p.store ? \`<span class="text-xs text-gray-400 font-medium">\${p.store}</span>\` : ''}
              </div>
              <h3 class="font-bold text-gray-800 text-sm mt-1 line-clamp-1">\${p.title}</h3>
              <div class="flex items-center gap-3 mt-1">
                \${p.price ? \`<span class="text-sm font-black text-indigo-700">\${p.price}</span>\` : ''}
                <a href="\${p.productUrl}" target="_blank" class="text-xs text-indigo-500 hover:underline truncate max-w-xs">\${p.productUrl}</a>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button data-action="featured" data-cat="\${p.categoryId}" data-id="\${p.id}"
                class="p-2 rounded-xl border transition-all \${p.featured ? 'bg-yellow-50 border-yellow-200 text-yellow-500 hover:bg-yellow-100' : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-yellow-50 hover:border-yellow-200 hover:text-yellow-500'}"
                title="\${p.featured ? 'Remover destaque' : 'Marcar como destaque'}">
                <i class="fas fa-star text-sm"></i>
              </button>
              <a href="\${p.productUrl}" target="_blank" 
                class="p-2 rounded-xl border bg-indigo-50 border-indigo-200 text-indigo-500 hover:bg-indigo-100 transition-all"
                title="Abrir produto">
                <i class="fas fa-external-link-alt text-sm"></i>
              </a>
              <button data-action="delete" data-cat="\${p.categoryId}" data-id="\${p.id}"
                class="p-2 rounded-xl border bg-red-50 border-red-200 text-red-400 hover:bg-red-100 transition-all"
                title="Remover produto">
                <i class="fas fa-trash text-sm"></i>
              </button>
            </div>
          </div>
        \`
      }).join('')
    }

    // Event delegation para botões da lista de produtos
    document.getElementById('productsList').addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action]')
      if (!btn) return
      const action = btn.dataset.action
      const cat = btn.dataset.cat
      const id = btn.dataset.id
      if (action === 'delete') {
        const found = allProducts.find(p => p.id === id)
        const title = (found && found.title) || btn.dataset.title || 'este produto'
        if (!confirm('Remover "' + title + '"?')) return
        try {
          const res = await fetch('/api/products/' + cat + '/' + id, { method: 'DELETE' })
          const data = await res.json()
          if (data.success) { showToast('Produto removido!', 'success'); await loadProducts() }
          else showToast(data.error || 'Erro ao remover', 'error')
        } catch(err) { showToast('Erro de conexão', 'error') }
      } else if (action === 'featured') {
        try {
          const res = await fetch('/api/products/' + cat + '/' + id + '/featured', { method: 'PATCH' })
          const data = await res.json()
          if (data.success) { showToast(data.product.featured ? '⭐ Marcado como destaque!' : 'Removido dos destaques', 'success'); await loadProducts() }
        } catch(err) { showToast('Erro de conexão', 'error') }
      }
    })

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
