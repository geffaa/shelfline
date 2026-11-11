CREATE TRIGGER customer_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.customer FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('customer');
