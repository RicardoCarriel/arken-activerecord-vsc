local Pedido_Item = Class.new("Pedido.Item", "ActiveRecord")

Pedido_Item.belongsTo{ name = 'pedido', record = 'Pedido', foreignKey = 'pedido_id' }

function Pedido_Item:subtotal()
  return self.quantidade * self.preco
end

return Pedido_Item
