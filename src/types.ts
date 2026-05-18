export type Category = {
  id: string
  name: string
  icon: string
  color: string
  description: string
}

export type Product = {
  id: string
  categoryId: string
  title: string
  description: string
  imageUrl: string
  productUrl: string
  price?: string
  rating?: number
  store?: string
  createdAt: string
  featured?: boolean
}

export const CATEGORIES: Category[] = [
  {
    id: 'eletronicos',
    name: 'Eletrônicos',
    icon: '💻',
    color: '#3B82F6',
    description: 'Smartphones, TVs, notebooks, tablets e mais'
  },
  {
    id: 'eletrodomesticos',
    name: 'Eletrodomésticos',
    icon: '🏠',
    color: '#8B5CF6',
    description: 'Geladeiras, fogões, máquinas de lavar e mais'
  },
  {
    id: 'ferramentas',
    name: 'Ferramentas Elétricas',
    icon: '🔧',
    color: '#F59E0B',
    description: 'Furadeiras, serras, parafusadeiras e mais'
  },
  {
    id: 'refrigeracao',
    name: 'Refrigeração',
    icon: '❄️',
    color: '#06B6D4',
    description: 'Ar condicionado, frigobar, coolers e mais'
  },
  {
    id: 'cama-mesa',
    name: 'Cama e Mesa',
    icon: '🛏️',
    color: '#EC4899',
    description: 'Jogos de cama, toalhas, travesseiros e mais'
  },
  {
    id: 'ventilacao',
    name: 'Ventilação',
    icon: '🌀',
    color: '#10B981',
    description: 'Ventiladores, exaustores, circuladores e mais'
  },
  {
    id: 'jardim',
    name: 'Jardim',
    icon: '🌿',
    color: '#84CC16',
    description: 'Cortadores de grama, regadores, ferramentas de jardim'
  }
]
